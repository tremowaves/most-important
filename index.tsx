/**
 * @fileoverview Control real time music with a MIDI controller
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { css, html, LitElement, svg, CSSResultGroup, TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators';
import { styleMap } from 'lit/directives/style-map';
import { classMap } from 'lit/directives/class-map';

import { GoogleGenAI, type LiveMusicSession, type LiveMusicServerMessage } from '@google/genai';
import { decode, decodeAudioData } from './utils'

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, apiVersion: 'v1alpha' });
const model = 'lyria-realtime-exp';

const LOCAL_STORAGE_LAST_ACTIVE_PROMPTS_KEY = 'promptDjLastActivePrompts';
const LOCAL_STORAGE_PRESETS_KEY = 'promptDjNamedPresets';


interface Prompt {
  readonly promptId: string;
  text: string;
  weight: number;
  cc: number;
  color: string;
}

interface Preset {
  name: string;
  prompts: Prompt[]; // Store as array for easier JSON serialization
}

interface ControlChange {
  channel: number;
  cc: number;
  value: number;
}

type PlaybackState = 'stopped' | 'playing' | 'loading' | 'paused';

/**
 * Throttles a callback to be called at most once per `delay` milliseconds.
 * Also returns the result of the last "fresh" call...
 */
function throttle<T extends (...args: Parameters<T>) => ReturnType<T>>(
  func: T,
  delay: number,
): (...args: Parameters<T>) => ReturnType<T> {
  let lastCall = -Infinity;
  let lastResult: ReturnType<T>;
  return (...args: Parameters<T>) => {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;
    if (timeSinceLastCall >= delay) {
      lastResult = func(...args);
      lastCall = now;
    }
    return lastResult;
  };
}

const DEFAULT_PROMPTS = [
  { color: '#9900ff', text: 'Bossa Nova' },
  { color: '#5200ff', text: 'Chillwave' },
  { color: '#ff25f6', text: 'Drum and Bass' },
  { color: '#2af6de', text: 'Post Punk' },
  { color: '#ffdd28', text: 'Shoegaze' },
  { color: '#2af6de', text: 'Funk' },
  { color: '#9900ff', text: 'Chiptune' },
  { color: '#3dffab', text: 'Lush Strings' },
  { color: '#d8ff3e', text: 'Sparkling Arpeggios' },
  { color: '#d9b2ff', text: 'Staccato Rhythms' },
  { color: '#3dffab', text: 'Punchy Kick' },
  { color: '#ffdd28', text: 'Dubstep' },
  { color: '#ff25f6', text: 'K Pop' },
  { color: '#d8ff3e', text: 'Neo Soul' },
  { color: '#5200ff', text: 'Trip Hop' },
  { color: '#d9b2ff', text: 'Thrash' },
];

// Toast Message component
// -----------------------------------------------------------------------------

@customElement('toast-message')
class ToastMessage extends LitElement {
  static override styles = css`
    .toast {
      line-height: 1.6;
      position: fixed;
      top: 20px; /* Adjusted to not overlap with new controls panel */
      left: 50%;
      transform: translateX(-50%);
      background-color: #222; /* Darker background */
      color: white;
      padding: 15px 20px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 15px;
      min-width: 250px;
      max-width: 80vw;
      transition: transform 0.5s cubic-bezier(0.19, 1, 0.22, 1), opacity 0.5s;
      z-index: 1000;
      box-shadow: 0 4px 15px rgba(0,0,0,0.2);
      border: 1px solid rgba(255,255,255,0.1);
      font-family: 'Google Sans', sans-serif;
    }
    button {
      border-radius: 50%;
      width: 24px;
      height: 24px;
      aspect-ratio: 1;
      border: none;
      color: #000;
      background-color: #ddd;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: bold;
      padding: 0;
    }
    button:hover {
      background-color: #ccc;
    }
    .toast:not(.showing) {
      transform: translate(-50%, -200%);
      opacity: 0;
      pointer-events: none;
    }
  `;

  @property({ type: String }) message = '';
  @property({ type: Boolean }) showing = false;
  private timeoutId: number | undefined;

  override render() {
    return html`<div class=${classMap({ showing: this.showing, toast: true })} role="alert" aria-live="assertive">
      <div class="message">${this.message}</div>
      <button @click=${this.hide} aria-label="Close message">✕</button>
    </div>`;
  }

  show(message: string, duration: number = 4000) {
    this.message = message;
    this.showing = true;
    clearTimeout(this.timeoutId);
    if (duration > 0) {
        this.timeoutId = window.setTimeout(() => this.hide(), duration);
    }
  }

  hide() {
    this.showing = false;
  }
}


// WeightKnob component (no changes from original)
// -----------------------------------------------------------------------------
@customElement('weight-knob')
class WeightKnob extends LitElement {
  static override styles = css`
    :host {
      cursor: grab;
      position: relative;
      width: 100%;
      aspect-ratio: 1;
      flex-shrink: 0;
      touch-action: none;
    }
    svg {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }
    #halo {
      position: absolute;
      z-index: -1;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      mix-blend-mode: lighten;
      transform: scale(2);
      will-change: transform;
    }
  `;

  @property({ type: Number }) value = 0;
  @property({ type: String }) color = '#000';
  @property({ type: Number }) audioLevel = 0;

  private dragStartPos = 0;
  private dragStartValue = 0;

  constructor() {
    super();
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
  }

  private handlePointerDown(e: PointerEvent) {
    if (e.button !== 0) return; // Only main button
    this.dragStartPos = e.clientY;
    this.dragStartValue = this.value;
    document.body.classList.add('dragging');
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    this.style.cursor = 'grabbing';
  }

  private handlePointerMove(e: PointerEvent) {
    const delta = this.dragStartPos - e.clientY;
    this.value = this.dragStartValue + delta * 0.01;
    this.value = Math.max(0, Math.min(2, this.value));
    this.dispatchEvent(new CustomEvent<number>('input', { detail: this.value }));
  }

  private handlePointerUp(e: PointerEvent) {
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    document.body.classList.remove('dragging');
    this.style.cursor = 'grab';
  }

  private handleWheel(e: WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY;
    this.value = this.value + delta * -0.0025;
    this.value = Math.max(0, Math.min(2, this.value));
    this.dispatchEvent(new CustomEvent<number>('input', { detail: this.value }));
  }

  private describeArc(
    centerX: number,
    centerY: number,
    startAngle: number,
    endAngle: number,
    radius: number,
  ): string {
    const startX = centerX + radius * Math.cos(startAngle);
    const startY = centerY + radius * Math.sin(startAngle);
    const endX = centerX + radius * Math.cos(endAngle);
    const endY = centerY + radius * Math.sin(endAngle);
    const largeArcFlag = endAngle - startAngle <= Math.PI ? '0' : '1';
    return `M ${startX} ${startY} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${endX} ${endY}`;
  }

  override render() {
    const MIN_HALO_SCALE = 1;
    const MAX_HALO_SCALE = 2;
    const HALO_LEVEL_MODIFIER = 1;

    const rotationRange = Math.PI * 2 * 0.75;
    const minRot = -rotationRange / 2 - Math.PI / 2;
    const maxRot = rotationRange / 2 - Math.PI / 2;
    const rot = minRot + (this.value / 2) * (maxRot - minRot);
    const dotStyle = styleMap({ transform: `translate(40px, 40px) rotate(${rot}rad)` });

    let scale = (this.value / 2) * (MAX_HALO_SCALE - MIN_HALO_SCALE);
    scale += MIN_HALO_SCALE;
    scale += this.audioLevel * HALO_LEVEL_MODIFIER;

    const haloStyle = styleMap({
      display: this.value > 0 ? 'block' : 'none',
      background: this.color,
      transform: `scale(${scale})`,
    });

    return html`
      <div id="halo" style=${haloStyle}></div>
      <svg viewBox="0 0 80 80">
        <ellipse opacity="0.4" cx="40" cy="40" rx="40" ry="40" fill="url(#f1)" />
        <g filter="url(#f2)">
          <ellipse cx="40" cy="40" rx="29" ry="29" fill="url(#f3)" />
        </g>
        <g filter="url(#f4)">
          <circle cx="40" cy="40" r="20.6667" fill="url(#f5)" />
        </g>
        <circle cx="40" cy="40" r="18" fill="url(#f6)" />
        <defs>
          <filter id="f2" x="8.33301" y="10.0488" width="63.333" height="64" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
            <feFlood flood-opacity="0" result="BackgroundImageFix" />
            <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
            <feOffset dy="2" /><feGaussianBlur stdDeviation="1.5" /><feComposite in2="hardAlpha" operator="out" />
            <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" /><feBlend mode="normal" in2="BackgroundImageFix" result="shadow1" />
            <feBlend mode="normal" in="SourceGraphic" in2="shadow1" result="shape" />
          </filter>
          <filter id="f4" x="11.333" y="19.0488" width="57.333" height="59.334" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
            <feFlood flood-opacity="0" result="BackgroundImageFix" />
            <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
            <feOffset dy="10" /><feGaussianBlur stdDeviation="4" /><feComposite in2="hardAlpha" operator="out" />
            <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" /><feBlend mode="normal" in2="BackgroundImageFix" result="shadow1" />
            <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
            <feMorphology radius="5" operator="erode" in="SourceAlpha" result="shadow2" />
            <feOffset dy="8" /><feGaussianBlur stdDeviation="3" /><feComposite in2="hardAlpha" operator="out" />
            <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" /><feBlend mode="normal" in2="shadow1" result="shadow2" />
            <feBlend mode="normal" in="SourceGraphic" in2="shadow2" result="shape" />
          </filter>
          <linearGradient id="f1" x1="40" y1="0" x2="40" y2="80" gradientUnits="userSpaceOnUse">
            <stop stop-opacity="0.5" /><stop offset="1" stop-color="white" stop-opacity="0.3" />
          </linearGradient>
          <radialGradient id="f3" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(40 40) rotate(90) scale(29 29)">
            <stop offset="0.6" stop-color="white" /><stop offset="1" stop-color="white" stop-opacity="0.7" />
          </radialGradient>
          <linearGradient id="f5" x1="40" y1="19.0488" x2="40" y2="60.3822" gradientUnits="userSpaceOnUse">
            <stop stop-color="white" /><stop offset="1" stop-color="#F2F2F2" />
          </linearGradient>
          <linearGradient id="f6" x1="40" y1="21.7148" x2="40" y2="57.7148" gradientUnits="userSpaceOnUse">
            <stop stop-color="#EBEBEB" /><stop offset="1" stop-color="white" />
          </linearGradient>
        </defs>
      </svg>
      <svg viewBox="0 0 80 80" @pointerdown=${this.handlePointerDown} @wheel=${this.handleWheel}>
        <g style=${dotStyle}> <circle cx="14" cy="0" r="2" fill="#000" /> </g>
        <path d=${this.describeArc(40, 40, minRot, maxRot, 34.5)} fill="none" stroke="#0003" stroke-width="3" stroke-linecap="round" />
        <path d=${this.describeArc(40, 40, minRot, rot, 34.5)} fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" />
      </svg>
    `;
  }
}

// Base class for icon buttons. (no changes from original)
class IconButton extends LitElement {
  static override styles = css`
    :host {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }
    :host(:hover) svg {
      transform: scale(1.2);
    }
    svg {
      width: 100%;
      height: 100%;
      transition: transform 0.5s cubic-bezier(0.25, 1.56, 0.32, 0.99);
    }
    .hitbox {
      pointer-events: all;
      position: absolute;
      width: 65%;
      aspect-ratio: 1;
      top: 9%;
      border-radius: 50%;
      cursor: pointer;
    }
  ` as CSSResultGroup;

  protected renderIcon() { return svg``; }

  private renderSVG() {
    return html` <svg width="140" height="140" viewBox="0 -10 140 150" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="22" y="6" width="96" height="96" rx="48" fill="black" fill-opacity="0.05" />
      <rect x="23.5" y="7.5" width="93" height="93" rx="46.5" stroke="black" stroke-opacity="0.3" stroke-width="3" />
      <g filter="url(#filter0_ddi_1048_7373)">
        <rect x="25" y="9" width="90" height="90" rx="45" fill="white" fill-opacity="0.05" shape-rendering="crispEdges" />
      </g>
      ${this.renderIcon()}
      <defs>
        <filter id="filter0_ddi_1048_7373" x="0" y="0" width="140" height="140" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
          <feOffset dy="2" /><feGaussianBlur stdDeviation="4" /><feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" /><feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_1048_7373" />
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
          <feOffset dy="16" /><feGaussianBlur stdDeviation="12.5" /><feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" /><feBlend mode="normal" in2="effect1_dropShadow_1048_7373" result="effect2_dropShadow_1048_7373" />
          <feBlend mode="normal" in="SourceGraphic" in2="effect2_dropShadow_1048_7373" result="shape" />
          <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" />
          <feOffset dy="3" /><feGaussianBlur stdDeviation="1.5" /><feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.05 0" /><feBlend mode="normal" in2="shape" result="effect3_innerShadow_1048_7373" />
        </filter></defs></svg>`;
  }
  override render() { return html`${this.renderSVG()}<div class="hitbox"></div>`; }
}

// PlayPauseButton (no changes from original)
// -----------------------------------------------------------------------------
@customElement('play-pause-button')
export class PlayPauseButton extends IconButton {
  @property({ type: String }) playbackState: PlaybackState = 'stopped';

  static override styles = [
    IconButton.styles,
    css`
      .loader { stroke: #ffffff; stroke-width: 3; stroke-linecap: round; animation: spin linear 1s infinite; transform-origin: center; transform-box: fill-box; }
      @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(359deg); } }
    `
  ] as CSSResultGroup;
  private renderPause() { return svg`<path d="M75.0037 69V39H83.7537V69H75.0037ZM56.2537 69V39H65.0037V69H56.2537Z" fill="#FEFEFE"/>`; }
  private renderPlay() { return svg`<path d="M60 71.5V36.5L87.5 54L60 71.5Z" fill="#FEFEFE" />`; }
  private renderLoading() { return svg`<path shape-rendering="crispEdges" class="loader" d="M70,74.2L70,74.2c-10.7,0-19.5-8.7-19.5-19.5l0,0c0-10.7,8.7-19.5,19.5-19.5l0,0c10.7,0,19.5,8.7,19.5,19.5l0,0"/>`; }
  override renderIcon() {
    if (this.playbackState === 'playing') return this.renderPause();
    else if (this.playbackState === 'loading') return this.renderLoading();
    return this.renderPlay();
  }
}

/** Simple class for dispatching MIDI CC messages as events. */
class MidiDispatcher extends EventTarget {
  private access: MIDIAccess | null = null;
  activeMidiInputId: string | null = null;
  private initialScanDone = false;

  async getMidiAccess(): Promise<string[]> {
    if (!navigator.requestMIDIAccess) {
      console.warn('Web MIDI API not supported in this browser.');
      this.dispatchEvent(new CustomEvent('midinotavailable'));
      return [];
    }

    if (!this.access && !this.initialScanDone) {
        try {
            this.access = await navigator.requestMIDIAccess({ sysex: false });
            this.initialScanDone = true; // Mark that initial attempt has been made
        } catch (error) {
            console.error('MIDI access request failed:', error);
            this.dispatchEvent(new CustomEvent('midinotavailable', {detail: error.message}));
            return [];
        }

        this.access.onstatechange = (event: MIDIConnectionEvent) => {
            console.log('MIDI state changed:', event.port.name, event.port.type, event.port.state);
            this.dispatchEvent(new CustomEvent('midideviceschange'));
             // If the active device is disconnected, try to select another one
            if (this.activeMidiInputId && event.port.id === this.activeMidiInputId && event.port.state === 'disconnected') {
                const inputIds = Array.from(this.access?.inputs.keys() || []);
                this.activeMidiInputId = inputIds.length > 0 ? inputIds[0] : null;
            }
        };
    }
    
    if (!this.access) return [];


    const inputIds = Array.from(this.access.inputs.keys());

    if (inputIds.length > 0 && this.activeMidiInputId === null) {
      this.activeMidiInputId = inputIds[0];
    } else if (inputIds.length === 0) {
        this.activeMidiInputId = null;
    }


    for (const input of this.access.inputs.values()) {
      // Make sure onmidimessage is fresh or correctly assigned
      input.onmidimessage = (event: MIDIMessageEvent) => {
        if (input.id !== this.activeMidiInputId) return;

        const { data } = event;
        if (!data) {
          console.error('MIDI message has no data');
          return;
        }

        const statusByte = data[0];
        const channel = statusByte & 0x0f;
        const messageType = statusByte & 0xf0;

        const isControlChange = messageType === 0xb0;
        if (!isControlChange) return;

        const detail: ControlChange = { cc: data[1], value: data[2], channel };
        this.dispatchEvent(new CustomEvent<ControlChange>('cc-message', { detail }));
      };
    }
    return inputIds;
  }

  getDeviceName(id: string): string | null {
    if (!this.access) return null;
    const input = this.access.inputs.get(id);
    return input ? input.name : null;
  }
}

/** Simple class for getting the current level from our audio element. */
class AudioAnalyser {
  readonly node: AnalyserNode;
  private readonly freqData: Uint8Array;
  constructor(context: AudioContext) {
    this.node = context.createAnalyser();
    this.node.fftSize = 256; // Smaller FFT for faster response, less detail
    this.node.smoothingTimeConstant = 0.3; // Some smoothing
    this.freqData = new Uint8Array(this.node.frequencyBinCount);
  }
  getCurrentLevel() {
    this.node.getByteFrequencyData(this.freqData);
    const avg = this.freqData.reduce((a, b) => a + b, 0) / this.freqData.length;
    return avg / 0xff; // Normalize to 0-1
  }
}

/** A single prompt input associated with a MIDI CC. */
@customElement('prompt-controller')
class PromptController extends LitElement {
  static override styles = css`
    .prompt { width: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    weight-knob { width: 70%; flex-shrink: 0; }
    #midi { font-family: monospace; text-align: center; font-size: 1.5vmin; border: 0.2vmin solid #fff; border-radius: 0.5vmin; padding: 2px 5px; color: #fff; background: #0006; cursor: pointer; visibility: hidden; user-select: none; margin-top: 0.75vmin;
      .learn-mode & { color: orange; border-color: orange; }
      .show-cc & { visibility: visible; }
    }
    #text { font-family: 'Google Sans', sans-serif; font-weight: 500; font-size: 1.8vmin; max-width: 100%; min-width: 2vmin; padding: 0.1em 0.3em; margin-top: 0.5vmin; flex-shrink: 0; border-radius: 0.25vmin; text-align: center; white-space: wrap; word-break: break-word; overflow: hidden; border: none; outline: none; -webkit-font-smoothing: antialiased; background: #000; color: #fff;
      &:not(:focus) { text-overflow: ellipsis; }
    }
    :host([filtered=true]) #text { background: #da2000; color: white; }
    @media only screen and (max-width: 600px) {
      #text { font-size: 2.3vmin; }
      weight-knob { width: 60%; }
    }
  `;

  @property({ type: String }) promptId = '';
  @property({ type: String }) text = '';
  @property({ type: Number }) weight = 0;
  @property({ type: String }) color = '';
  @property({ type: Number }) cc = 0;
  @property({ type: Number }) channel = 0;
  @property({ type: Boolean, reflect: true }) learnMode = false;
  @property({ type: Boolean }) showCC = false;
  @property({ type: Boolean, reflect: true }) filtered = false;

  @query('weight-knob') private weightInput!: WeightKnob;
  @query('#text') private textInput!: HTMLInputElement;
  @property({ type: Object }) midiDispatcher: MidiDispatcher | null = null;
  @property({ type: Number }) audioLevel = 0;
  private lastValidText!: string;

  override connectedCallback() {
    super.connectedCallback();
    this.midiDispatcher?.addEventListener('cc-message', this.handleCCMessage.bind(this) as EventListener);
  }

  override disconnectedCallback(): void {
      super.disconnectedCallback();
      this.midiDispatcher?.removeEventListener('cc-message', this.handleCCMessage.bind(this) as EventListener);
  }

  private handleCCMessage(e: CustomEvent<ControlChange>) {
    const { channel, cc, value } = e.detail;
    if (this.learnMode) {
      this.cc = cc;
      // this.channel = channel; // Channel not actively used for matching yet, but store it
      this.learnMode = false;
      this.dispatchPromptChange();
    } else if (cc === this.cc) {
      this.weight = (value / 127) * 2; // Max weight is 2
      this.dispatchPromptChange();
    }
  }

  override firstUpdated() {
    this.textInput.setAttribute('contenteditable', 'plaintext-only');
    this.textInput.textContent = this.text;
    this.lastValidText = this.text;
  }

  update(changedProperties: Map<string, unknown>) {
    if (changedProperties.has('showCC') && !this.showCC) this.learnMode = false;
    if (changedProperties.has('text') && this.textInput && this.textInput.textContent !== this.text) {
        this.textInput.textContent = this.text;
    }
    if (changedProperties.has('learnMode')) {
        this.requestUpdate(); // ensure classMap updates
    }
    super.update(changedProperties);
  }

  private dispatchPromptChange() {
    this.dispatchEvent(new CustomEvent<Prompt>('prompt-changed', {
      detail: { promptId: this.promptId, text: this.text, weight: this.weight, cc: this.cc, color: this.color },
    }));
  }

  private async updateText() {
    const newText = this.textInput.textContent?.trim();
    if (!newText || newText.length === 0) {
      this.textInput.textContent = this.lastValidText; // Revert if empty
    } else {
      this.text = newText;
      this.lastValidText = newText;
    }
    this.dispatchPromptChange();
  }

  private onFocus() {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(this.textInput);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  private updateWeight() {
    this.weight = this.weightInput.value;
    this.dispatchPromptChange();
  }
  private toggleLearnMode() { this.learnMode = !this.learnMode; }

  override render() {
    const classes = classMap({ 'prompt': true, 'learn-mode': this.learnMode, 'show-cc': this.showCC });
    return html`<div class=${classes}>
      <weight-knob id="weight" .value=${this.weight} .color=${this.color} .audioLevel=${this.audioLevel} @input=${this.updateWeight}></weight-knob>
      <span id="text" spellcheck="false" @focus=${this.onFocus} @blur=${this.updateText} @keydown=${(e:KeyboardEvent) => {if(e.key === 'Enter'){ e.preventDefault(); this.textInput.blur();}}} ></span>
      <div id="midi" @click=${this.toggleLearnMode} title=${this.learnMode ? 'Waiting for MIDI CC...' : `Click to learn MIDI CC (Current: ${this.cc})`}>
        ${this.learnMode ? 'Learn...' : `CC:${this.cc}`}
      </div>
    </div>`;
  }
}

/** The grid of prompt inputs. */
@customElement('prompt-dj-midi')
class PromptDjMidi extends LitElement {
  static override styles = css`
    :host { height: 100%; display: flex; flex-direction: column; justify-content: center; align-items: center; box-sizing: border-box; position: relative; padding-top: 70px; /* Space for controls panel */ }
    #background { will-change: background-image; position: absolute; top:0; left:0; height: 100%; width: 100%; z-index: -1; background: #111; }
    #grid { width: 80vmin; height: 80vmin; display: grid; grid-template-columns: repeat(4, 1fr); gap: 2.5vmin; margin-top: 2vmin; /* Reduced margin-top */ }
    prompt-controller { width: 100%; }
    play-pause-button { position: relative; width: 15vmin; margin-top: 2vmin; }
    
    .download-recording-button {
        margin-top: 1vmin;
        padding: 0.8vmin 1.5vmin;
        background-color: #4CAF50; /* Green */
        border: none;
        color: white;
        text-align: center;
        text-decoration: none;
        display: inline-block;
        font-size: 1.5vmin;
        border-radius: 5px;
        cursor: pointer;
    }
    .download-recording-button:hover {
        background-color: #45a049;
    }

    /* CSS for file input is in global styles (index.css) */
    /* Controls panel styling is in global styles (index.css) */
  `;

  private prompts: Map<string, Prompt>;
  private midiDispatcher: MidiDispatcher;
  private audioAnalyser: AudioAnalyser;

  @state() private playbackState: PlaybackState = 'stopped';
  private session!: LiveMusicSession; // Initialized in connectToSession
  private audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  private outputNode: GainNode = this.audioContext.createGain();
  private nextStartTime = 0;
  private readonly bufferTime = 2; 

  @state() private showMidi = false;
  @state() private audioLevel = 0;
  @state() private midiInputIds: string[] = [];
  @state() private activeMidiInputId: string | null = null;
  @state() private filteredPrompts = new Set<string>();
  private audioLevelRafId: number | null = null;
  private connectionError = true;

  // Recording states
  @state() private isRecording: boolean = false;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  @state() private recordedAudioURL: string | null = null;
  private streamDestination: MediaStreamAudioDestinationNode | null = null;

  // Preset states
  @state() private namedPresets: Preset[] = [];
  @state() private activePresetName: string | null = null;
  @query('#preset-load-select') private presetLoadSelect!: HTMLSelectElement;
  @query('#import-file-input') private importFileInput!: HTMLInputElement;


  @query('play-pause-button') private playPauseButton!: PlayPauseButton;
  @query('toast-message') private toastMessage!: ToastMessage;

  constructor(initialPrompts: Map<string, Prompt>, midiDispatcher: MidiDispatcher) {
    super();
    this.prompts = initialPrompts;
    this.midiDispatcher = midiDispatcher;
    this.midiDispatcher.addEventListener('midideviceschange', this.handleMidiDevicesChange.bind(this));
    this.midiDispatcher.addEventListener('midinotavailable', (e: Event) => {
        const customEvent = e as CustomEvent<string>;
        this.toastMessage.show(`MIDI not available: ${customEvent.detail || 'Unknown error.'}. Try refreshing.`, 5000);
        this.showMidi = false;
    });

    this.audioAnalyser = new AudioAnalyser(this.audioContext);
    this.setupAudioNodes();
    this.updateAudioLevel = this.updateAudioLevel.bind(this);
  }

  private setupAudioNodes() {
    this.outputNode.disconnect(); // Disconnect old node if any
    this.outputNode = this.audioContext.createGain();
    this.outputNode.connect(this.audioAnalyser.node);
    this.outputNode.connect(this.audioContext.destination);

    if (this.audioContext.state === 'suspended') {
        this.audioContext.resume();
    }

    // Setup for recording
    if (!this.streamDestination) {
        this.streamDestination = this.audioContext.createMediaStreamDestination();
    }
    this.outputNode.connect(this.streamDestination); // Connect output to recording destination
  }


  override async connectedCallback() {
    super.connectedCallback();
    this.loadPresetsFromStorage(); // Load named presets
    // Initial prompts are already set by constructor from getInitialPrompts (last active)
    await this.connectToSession();
    await this.setSessionPrompts();
    this.updateAudioLevel(); // Start audio level updates
     // Request update to ensure MIDI device list is populated if showMidi is true initially
    await this.refreshMidiDeviceList();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.audioLevelRafId) cancelAnimationFrame(this.audioLevelRafId);
    this.midiDispatcher.removeEventListener('midideviceschange', this.handleMidiDevicesChange.bind(this));
    this.session?.close();
    this.audioContext.close();
  }


  private async connectToSession() {
    if (this.session && !this.connectionError) { // Don't reconnect if already connected and fine
      try {
        await this.session.getServerInfo(); // Simple check
        return;
      } catch (e) {
        console.warn("Session check failed, reconnecting", e);
      }
    }

    this.playbackState = 'loading';
    this.toastMessage.show('Connecting to music session...', 2000);
    try {
      this.session = await ai.live.music.connect({
        model: model,
        callbacks: {
          onmessage: async (e: LiveMusicServerMessage) => {
            if (e.setupComplete) {
              this.connectionError = false;
              this.toastMessage.show('Music session connected!', 2000);
              if (this.playbackState === 'loading' && this.getPromptsToSend().length > 0) {
                 // If it was loading due to connection, and now connected, transition to playing
                 // but audio chunks will handle the actual transition after bufferTime
              } else if (this.getPromptsToSend().length === 0 && this.playbackState !== 'paused' && this.playbackState !== 'stopped'){
                this.pause(); // Auto-pause if no prompts are active on connect
              }
            }
            if (e.filteredPrompt) {
              this.filteredPrompts = new Set([...this.filteredPrompts, e.filteredPrompt.text])
              this.toastMessage.show(`Prompt filtered: ${e.filteredPrompt.text} - ${e.filteredPrompt.filteredReason}`, 5000);
              this.requestUpdate(); // Update UI for filtered prompts
            }
            if (e.serverContent?.audioChunks !== undefined) {
              if (this.playbackState === 'paused' || this.playbackState === 'stopped') return;
              const audioBuffer = await decodeAudioData(
                decode(e.serverContent?.audioChunks[0].data), this.audioContext, 48000, 2,
              );
              const source = this.audioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              if (this.nextStartTime === 0) { // First chunk after play or reset
                this.nextStartTime = this.audioContext.currentTime + this.bufferTime;
                setTimeout(() => {
                  // Only transition to playing if still in loading (i.e. not paused/stopped by user)
                  if(this.playbackState === 'loading') this.playbackState = 'playing';
                }, this.bufferTime * 1000);
              }

              if (this.nextStartTime < this.audioContext.currentTime) { // Buffer underrun
                console.warn('Buffer underrun, resetting start time.');
                this.toastMessage.show('Network latency detected, re-buffering...', 2000);
                this.playbackState = 'loading'; // Go back to loading to re-sync
                this.nextStartTime = this.audioContext.currentTime + this.bufferTime; // Reset with new buffer
                 // Discard old audio sources to prevent overlap
                // (This part is tricky with live audio, often handled by the audio graph itself if sources are one-shot)
              }
              source.start(this.nextStartTime);
              this.nextStartTime += audioBuffer.duration;
            }
          },
          onerror: (errEvent: ErrorEvent) => {
            console.error('LiveMusicSession error:', errEvent);
            this.connectionError = true;
            this.stop(true); // true indicates an error stop
            this.toastMessage.show(`Connection error: ${errEvent.message || 'Please restart audio.'}`, 5000);
          },
          onclose: (closeEvent: CloseEvent) => {
            console.warn('LiveMusicSession closed:', closeEvent);
            if (!this.connectionError) { // If not already an error (e.g. manual stop)
                 this.toastMessage.show('Music session closed.', 3000);
            }
            this.connectionError = true; // Assume connection is lost
            this.stop(true); // Treat as an error stop to be safe
          },
        },
      });
    } catch (error) {
        console.error("Failed to connect to session:", error);
        this.toastMessage.show(`Failed to connect: ${error.message}`, 5000);
        this.connectionError = true;
        this.playbackState = 'stopped';
    }
  }

  private getPromptsToSend(): Prompt[] {
    return Array.from(this.prompts.values())
      .filter((p) => !this.filteredPrompts.has(p.text) && p.weight > 0);
  }

  private setSessionPrompts = throttle(async () => {
    if (this.connectionError && (this.playbackState === 'playing' || this.playbackState === 'loading')) {
        this.toastMessage.show('No connection to music session. Attempting to reconnect...', 3000);
        await this.connectToSession(); // Try to reconnect before setting prompts
        if (this.connectionError) { // If still no connection
            this.pause(); // Pause if connection fails
            return;
        }
    }

    const promptsToSend = this.getPromptsToSend();
    if (promptsToSend.length === 0 && (this.playbackState === 'playing' || this.playbackState === 'loading')) {
      this.toastMessage.show('Add some weight to a prompt to make music!', 3000)
      this.pause(); // Pause if no active prompts
      return;
    }

    if (this.playbackState === 'stopped' || this.playbackState === 'paused') {
        // Don't send prompts if we are not supposed to be playing.
        // However, if we are about to play, prompts will be sent by the play() method.
        return;
    }
    
    if (!this.session || this.connectionError) {
      // If session is not ready or error, don't try to send.
      // connectToSession or play() should handle establishing it.
      return;
    }

    try {
      await this.session.setWeightedPrompts({ weightedPrompts: promptsToSend });
      // Clear filtered prompts that are no longer in the active set or have changed text
      const currentActiveTexts = new Set(promptsToSend.map(p => p.text));
      this.filteredPrompts = new Set([...this.filteredPrompts].filter(fp => currentActiveTexts.has(fp)));

    } catch (e) {
      this.toastMessage.show(`Error setting prompts: ${e.message}`, 4000);
      console.error("setWeightedPrompts error:", e);
      this.pause(); // Pause on error
    }
  }, 200);

  private updateAudioLevel() {
    this.audioLevel = this.audioAnalyser.getCurrentLevel();
    this.audioLevelRafId = requestAnimationFrame(this.updateAudioLevel);
  }

  private dispatchPromptsChange() { // For external listeners, not used internally in this version
    this.dispatchEvent(new CustomEvent('prompts-changed', { detail: this.prompts }));
    // This now also triggers sending to Lyria session
    this.setSessionPrompts();
  }

  private handlePromptChanged(e: CustomEvent<Prompt>) {
    const changedPrompt = e.detail;
    const prompt = this.prompts.get(changedPrompt.promptId);

    if (!prompt) {
      console.error('Prompt not found during update:', changedPrompt.promptId);
      return;
    }

    prompt.text = changedPrompt.text;
    prompt.weight = changedPrompt.weight;
    prompt.cc = changedPrompt.cc;
    // Color is part of prompt creation, not changed here typically

    const newPrompts = new Map(this.prompts);
    newPrompts.set(prompt.promptId, prompt);
    this.setPrompts(newPrompts); // This will trigger updates and saving last active
  }

  private setPrompts(newPrompts: Map<string, Prompt>, fromPresetLoad: boolean = false) {
    this.prompts = new Map(newPrompts); // Ensure it's a new map for reactivity if needed
    if (!fromPresetLoad) { // If not loading a preset, this change might make current preset dirty
        // Could add a 'dirty' flag for active preset here if desired
    }
    this.setLastActivePromptsToLocalStorage(this.prompts);
    this.requestUpdate(); // LitElement: request a re-render
    this.dispatchPromptsChange(); // This will also call setSessionPrompts
  }


  private readonly makeBackground = throttle(() => {
    const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
    const MAX_WEIGHT = 0.5; const MAX_ALPHA = 0.6;
    const bg: string[] = [];
    [...this.prompts.values()].forEach((p, i) => {
      const alphaPct = clamp01(p.weight / MAX_WEIGHT) * MAX_ALPHA;
      const alpha = Math.round(alphaPct * 0xff).toString(16).padStart(2, '0');
      const stop = p.weight / 2; const x = (i % 4) / 3; const y = Math.floor(i / 4) / 3;
      const s = `radial-gradient(circle at ${x * 100}% ${y * 100}%, ${p.color}${alpha} 0px, ${p.color}00 ${stop * 100}%)`;
      bg.push(s);
    });
    return bg.join(', ');
  }, 30);


  // --- Playback Controls with Recording ---

  private async play() {
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    this.setupAudioNodes(); // Ensure audio nodes are fresh, especially after stop/pause

    if (this.connectionError) {
        this.toastMessage.show('Reconnecting to session before playing...', 2000);
        await this.connectToSession();
        if (this.connectionError) {
            this.toastMessage.show('Connection failed. Cannot play.', 3000);
            this.playbackState = 'stopped'; // Ensure it's stopped
            return;
        }
    }
    
    const promptsToSend = this.getPromptsToSend();
    if (promptsToSend.length === 0) {
      this.toastMessage.show('Turn up a knob to make some music!', 3000)
      this.pause(); // Or 'stopped' if it was stopped before
      return;
    }

    this.playbackState = 'loading'; // Go to loading first, then to playing after first audio chunk
    this.outputNode.gain.setValueAtTime(0, this.audioContext.currentTime); // Fade in
    this.outputNode.gain.linearRampToValueAtTime(1, this.audioContext.currentTime + 0.2);
    
    await this.setSessionPrompts(); // Send current prompts
    this.session.play(); // Tell Lyria to start sending audio
    this.startRecording();
  }

  private pause() {
    if (this.playbackState !== 'playing' && this.playbackState !== 'loading') return;
    
    this.session?.pause(); // Tell Lyria to stop sending audio
    this.outputNode.gain.setValueAtTime(this.outputNode.gain.value, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.2); // Fade out
    
    this.playbackState = 'paused';
    this.stopRecordingAndOfferDownload();
    // Don't reset nextStartTime here, so resume can be smoother if Lyria supports it.
    // However, Lyria might reset on its end. Our current logic re-buffers on play from pause.
    this.nextStartTime = 0; // Force re-buffer on next play for this implementation
  }

  private stop(isErrorStop: boolean = false) {
    this.session?.stop(); // Tell Lyria to completely stop the current generation
    this.outputNode.gain.setValueAtTime(this.outputNode.gain.value, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.1);
    
    this.playbackState = 'stopped';
    this.nextStartTime = 0; // Reset for a fresh play
    
    if (!isErrorStop) { // Don't offer download if it was an error that forced stop
        this.stopRecordingAndOfferDownload();
    } else {
        this.stopRecordingCleanup(); // Just cleanup recorder if it was an error
    }
    // Re-initialize outputNode for next play to ensure clean state
    // This is now handled by setupAudioNodes() in play()
  }

  private async handlePlayPause() {
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume().catch(err => console.error("AudioContext resume failed:", err));
    }

    switch (this.playbackState) {
      case 'playing':
        this.pause();
        break;
      case 'paused':
      case 'stopped':
        await this.play();
        break;
      case 'loading': // If clicked while loading, treat as a "stop/reset" action
        this.stop();
        break;
    }
  }


  // --- Recording Logic ---
  private startRecording() {
    if (!this.streamDestination) {
        console.error("Stream destination not available for recording.");
        this.toastMessage.show("Error: Cannot start recording.", 3000);
        return;
    }
    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
        this.mediaRecorder.stop(); // Stop previous if any
    }
    this.recordedChunks = [];
    this.recordedAudioURL = null; // Clear previous download link

    try {
        const options = { mimeType: 'audio/webm;codecs=opus' }; // opus is good for quality and size
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            console.warn(`${options.mimeType} not supported, trying default.`);
            delete options.mimeType; // try default
        }
        this.mediaRecorder = new MediaRecorder(this.streamDestination.stream, options);
    } catch (e) {
        console.error("MediaRecorder setup failed:", e);
        this.toastMessage.show(`Recording setup failed: ${e.message}`, 4000);
        return;
    }
    

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.recordedChunks.push(event.data);
    };

    this.mediaRecorder.onstop = () => {
      if (this.recordedChunks.length > 0) {
        const blob = new Blob(this.recordedChunks, { type: this.mediaRecorder?.mimeType || 'audio/webm' });
        this.recordedAudioURL = URL.createObjectURL(blob);
        // No auto-download, user will click button
        this.toastMessage.show("Recording finished. Download is available.", 3000);
      } else {
         this.recordedAudioURL = null; // Ensure no stale URL if no data
      }
      this.isRecording = false;
      // Do not clear recordedChunks here, URL needs them until revoked.
    };
    
    this.mediaRecorder.onerror = (event) => {
        console.error("MediaRecorder error:", event);
        this.toastMessage.show(`Recording error: ${event.error.message}`, 4000);
        this.isRecording = false;
        this.recordedAudioURL = null;
    };

    this.mediaRecorder.start();
    this.isRecording = true;
    this.toastMessage.show("Recording started...", 2000);
  }

  private stopRecordingAndOfferDownload() {
    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      this.mediaRecorder.stop(); // onstop handler will set URL and toast
    }
    // isRecording state is handled by onstop
  }
  
  private stopRecordingCleanup() {
    // Used when an error occurs or we don't want to offer download
    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      // Remove ondataavailable and onstop before stopping to prevent processing
      this.mediaRecorder.ondataavailable = null;
      this.mediaRecorder.onstop = null;
      this.mediaRecorder.stop();
    }
    this.isRecording = false;
    this.recordedChunks = [];
    if (this.recordedAudioURL) {
        URL.revokeObjectURL(this.recordedAudioURL); // Clean up old URL
        this.recordedAudioURL = null;
    }
  }


  private handleDownloadRecording() {
    if (!this.recordedAudioURL) {
        this.toastMessage.show("No recording available to download.", 3000);
        return;
    }
    const a = document.createElement('a');
    a.href = this.recordedAudioURL;
    const filename = `PromptDJ_Recording_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.webm`;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // URL.revokeObjectURL(this.recordedAudioURL); // Keep it available for more downloads unless new recording starts
    this.toastMessage.show(`Downloading: ${filename}`, 3000);
  }


  // --- MIDI Controls ---
  private async refreshMidiDeviceList() {
    try {
        const inputIds = await this.midiDispatcher.getMidiAccess();
        this.midiInputIds = inputIds;
        if (this.activeMidiInputId && !inputIds.includes(this.activeMidiInputId)) {
             // Active device disconnected
            this.activeMidiInputId = inputIds.length > 0 ? inputIds[0] : null;
            this.midiDispatcher.activeMidiInputId = this.activeMidiInputId;
            this.toastMessage.show(this.activeMidiInputId ? `MIDI device changed to ${this.midiDispatcher.getDeviceName(this.activeMidiInputId)}` : "Active MIDI device disconnected.", 3000);
        } else if (!this.activeMidiInputId && inputIds.length > 0) {
            this.activeMidiInputId = inputIds[0];
            this.midiDispatcher.activeMidiInputId = this.activeMidiInputId;
        } else if (inputIds.length === 0) {
            this.activeMidiInputId = null;
            this.midiDispatcher.activeMidiInputId = null;
        }
    } catch (e) {
        this.toastMessage.show(`Could not get MIDI devices: ${e.message}`, 3000);
        this.midiInputIds = [];
    }
  }
  private async toggleShowMidi() {
    this.showMidi = !this.showMidi;
    if (this.showMidi) {
      await this.refreshMidiDeviceList();
    }
  }

  private handleMidiInputChange(event: Event) {
    const selectElement = event.target as HTMLSelectElement;
    const newMidiId = selectElement.value;
    this.activeMidiInputId = newMidiId !== "" ? newMidiId : null;
    this.midiDispatcher.activeMidiInputId = this.activeMidiInputId;
    if(this.activeMidiInputId) {
        this.toastMessage.show(`MIDI input set to: ${this.midiDispatcher.getDeviceName(this.activeMidiInputId)}`, 2000);
    }
  }
  
  private async handleMidiDevicesChange() {
    this.toastMessage.show("MIDI device list changed. Refreshing...", 2000);
    if (this.showMidi) { // Only refresh list if panel is visible
      await this.refreshMidiDeviceList();
    }
  }

  // --- Preset Logic ---
  private loadPresetsFromStorage() {
    const storedPresets = localStorage.getItem(LOCAL_STORAGE_PRESETS_KEY);
    if (storedPresets) {
      try {
        this.namedPresets = JSON.parse(storedPresets) as Preset[];
      } catch (e) {
        console.error("Failed to parse stored presets:", e);
        this.namedPresets = [];
        this.toastMessage.show("Error loading presets from storage.", 3000);
      }
    }
  }

  private savePresetsToStorage() {
    try {
      localStorage.setItem(LOCAL_STORAGE_PRESETS_KEY, JSON.stringify(this.namedPresets));
    } catch (e) {
      console.error("Failed to save presets to storage:", e);
      this.toastMessage.show("Error saving presets. Storage might be full.", 4000);
    }
  }

  private setLastActivePromptsToLocalStorage(promptsToSave: Map<string, Prompt>) {
    try {
      const storablePrompts = Array.from(promptsToSave.values());
      localStorage.setItem(LOCAL_STORAGE_LAST_ACTIVE_PROMPTS_KEY, JSON.stringify(storablePrompts));
    } catch (e) {
      console.error("Failed to save last active prompts:", e);
      // Non-critical, so maybe a silent fail or a less intrusive toast.
    }
  }

  private handleSavePresetAs() {
    const name = prompt("Enter preset name:", this.activePresetName || "My Preset");
    if (!name) return;

    const existingPresetIndex = this.namedPresets.findIndex(p => p.name === name);
    if (existingPresetIndex !== -1) {
      if (!confirm(`Preset "${name}" already exists. Overwrite?`)) {
        return;
      }
      this.namedPresets.splice(existingPresetIndex, 1); // Remove old one
    }
    
    const newPreset: Preset = { name, prompts: Array.from(this.prompts.values()) };
    this.namedPresets.push(newPreset);
    this.namedPresets.sort((a, b) => a.name.localeCompare(b.name)); // Keep sorted
    this.activePresetName = name;
    this.savePresetsToStorage();
    this.setLastActivePromptsToLocalStorage(this.prompts); // Also update last active
    this.toastMessage.show(`Preset "${name}" saved.`, 2000);
  }

  private handleSaveCurrentPreset() {
    if (!this.activePresetName) {
      this.handleSavePresetAs();
      return;
    }
    const presetIndex = this.namedPresets.findIndex(p => p.name === this.activePresetName);
    if (presetIndex === -1) {
      this.toastMessage.show(`Error: Active preset "${this.activePresetName}" not found. Use "Save As..."`, 3000);
      this.activePresetName = null; // Clear invalid active preset name
      return;
    }
    this.namedPresets[presetIndex].prompts = Array.from(this.prompts.values());
    this.savePresetsToStorage();
    this.setLastActivePromptsToLocalStorage(this.prompts);
    this.toastMessage.show(`Preset "${this.activePresetName}" updated.`, 2000);
  }

  private handleLoadPreset(event: Event) {
    const select = event.target as HTMLSelectElement;
    const name = select.value;
    if (!name) return;

    const preset = this.namedPresets.find(p => p.name === name);
    if (preset) {
      const newPromptsMap = new Map<string, Prompt>();
      preset.prompts.forEach(p => newPromptsMap.set(p.promptId, {...p})); // Create new objects
      
      this.setPrompts(newPromptsMap, true); // true indicates from preset load
      this.activePresetName = name;
      this.filteredPrompts.clear(); // Clear filtered prompts when loading a new preset
      this.setSessionPrompts(); // Update Lyria with new prompts
      this.toastMessage.show(`Preset "${name}" loaded.`, 2000);
    } else {
        this.toastMessage.show(`Preset "${name}" not found.`, 3000);
    }
  }

  private handleDeleteCurrentPreset() {
    if (!this.activePresetName) {
      this.toastMessage.show("No active preset selected to delete.", 2000);
      return;
    }
    if (!confirm(`Are you sure you want to delete preset "${this.activePresetName}"?`)) {
      return;
    }
    this.namedPresets = this.namedPresets.filter(p => p.name !== this.activePresetName);
    const deletedName = this.activePresetName;
    this.activePresetName = null;
    this.savePresetsToStorage();
    this.toastMessage.show(`Preset "${deletedName}" deleted.`, 2000);
  }

  private handleExportKnobs() {
    const dataStr = JSON.stringify({
        name: this.activePresetName || "current-knobs",
        prompts: Array.from(this.prompts.values())
    }, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    
    const exportFileDefaultName = `${(this.activePresetName || 'current-knobs').replace(/\s+/g, '_')}.json`;
    
    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
    this.toastMessage.show(`Exported as ${exportFileDefaultName}`, 2000);
  }
  
  private triggerImportFile() {
    this.importFileInput.click();
  }

  private async handleImportPreset(event: Event) {
    const fileInput = event.target as HTMLInputElement;
    const file = fileInput.files?.[0];
    if (!file) return;

    try {
      const fileContent = await file.text();
      const importedData = JSON.parse(fileContent);
      
      let importedPrompts: Prompt[];
      let suggestedName = file.name.replace(/\.json$/, "").replace(/_/g, " ");

      // Check if root is Preset object or just array of prompts
      if (importedData.prompts && Array.isArray(importedData.prompts) && typeof importedData.name === 'string') {
         importedPrompts = importedData.prompts as Prompt[];
         suggestedName = importedData.name;
      } else if (Array.isArray(importedData)) { // Legacy format perhaps, just an array of prompts
         importedPrompts = importedData as Prompt[];
      } else {
          throw new Error("Invalid preset file format. Expected an object with a 'prompts' array or just an array of prompts.");
      }
      
      // Basic validation of prompts structure
      if (!importedPrompts.every(p => p.promptId && p.text != null && p.weight != null && p.cc != null && p.color != null)) {
        throw new Error("Preset file contains invalid prompt data.");
      }

      const name = prompt("Enter name for imported preset:", suggestedName);
      if (!name) {
        fileInput.value = ''; // Reset file input
        return;
      }

      if (this.namedPresets.some(p => p.name === name)) {
        if (!confirm(`Preset "${name}" already exists. Overwrite?`)) {
          fileInput.value = ''; // Reset file input
          return;
        }
        this.namedPresets = this.namedPresets.filter(p => p.name !== name);
      }
      
      // Ensure imported prompts have unique promptIds consistent with our app's structure
      // or map them if necessary. For now, assume they are compatible or we map by index.
      // The safest is to map to existing promptIds by index if count matches, or rebuild.
      // For simplicity here: we use the imported prompts directly but assign them to the
      // existing 16 slots by index if the number of imported prompts is <= 16.
      // This could be made more robust.
      
      const currentPromptIds = Array.from(this.prompts.keys());
      const finalPromptsForPreset: Prompt[] = [];
      const defaultStructure = buildDefaultPrompts(); // Get a base structure with all 16 promptIds

      defaultStructure.forEach((defaultP, index) => {
          if (index < importedPrompts.length) {
              const importedP = importedPrompts[index];
              finalPromptsForPreset.push({
                  ...defaultP, // takes promptId and default color from our structure
                  text: importedP.text,
                  weight: importedP.weight,
                  cc: importedP.cc,
                  color: importedP.color || defaultP.color, // Use imported color if available
              });
          } else {
              finalPromptsForPreset.push({...defaultP, weight: 0}); // Fill remaining with defaults (0 weight)
          }
      });


      const newPreset: Preset = { name, prompts: finalPromptsForPreset };
      this.namedPresets.push(newPreset);
      this.namedPresets.sort((a, b) => a.name.localeCompare(b.name));
      this.savePresetsToStorage();
      
      // Optionally load the imported preset immediately
      // this.setPrompts(new Map(finalPromptsForPreset.map(p => [p.promptId, p])), true);
      // this.activePresetName = name;
      // this.setSessionPrompts();

      this.toastMessage.show(`Preset "${name}" imported successfully. You can now load it.`, 3000);

    } catch (e) {
      console.error("Failed to import preset:", e);
      this.toastMessage.show(`Error importing preset: ${e.message}`, 4000);
    } finally {
      fileInput.value = ''; // Reset file input
    }
  }

  private resetAllKnobsToDefault() {
    if (confirm("Reset all knobs to their default state? This will not affect your saved presets.")) {
        const defaultPromptsMap = buildDefaultPrompts();
        this.setPrompts(defaultPromptsMap); // This updates UI, saves to lastActive, and sends to Lyria
        this.activePresetName = null; // No preset is active after a reset to default
        this.filteredPrompts.clear();
        this.toastMessage.show("Knobs reset to default.", 2000);
    }
  }


  override render() {
    const bg = styleMap({ backgroundImage: this.makeBackground() });
    return html`
      <div id="background" style=${bg}></div>
      <toast-message></toast-message>
      
      <div class="controls-panel" role="toolbar" aria-label="Main Controls">
        <div>
          <button @click=${this.toggleShowMidi} class=${this.showMidi ? 'active' : ''} aria-pressed=${this.showMidi} aria-label="Toggle MIDI Controls">MIDI</button>
          <select id="midi-device-select"
            @change=${this.handleMidiInputChange}
            .value=${this.activeMidiInputId || ''}
            style=${this.showMidi ? '' : 'display: none;'}
            aria-label="Select MIDI Device">
            ${this.midiInputIds.length > 0
              ? this.midiInputIds.map(id => html`<option value=${id}>${this.midiDispatcher.getDeviceName(id)}</option>`)
              : html`<option value="">${this.midiDispatcher.activeMidiInputId === null && this.midiInputIds.length === 0 ? "No MIDI devices found" : "Select MIDI Device"}</option>`}
          </select>
        </div>
        <div>
            <label for="preset-load-select">Preset:</label>
            <select id="preset-load-select" @change=${this.handleLoadPreset} .value=${this.activePresetName || ""} aria-label="Load Preset">
                <option value="">${this.activePresetName ? this.activePresetName + (this.namedPresets.find(p=>p.name === this.activePresetName) ? "" : " (unsaved)") : "Load Preset..."}</option>
                ${this.namedPresets.map(p => html`<option value=${p.name}>${p.name}</option>`)}
            </select>
            <button @click=${this.handleSaveCurrentPreset} title="Save changes to current preset" aria-label="Save Current Preset">Save</button>
            <button @click=${this.handleSavePresetAs} title="Save current knobs as a new preset" aria-label="Save Preset As">Save As...</button>
            <button @click=${this.handleDeleteCurrentPreset} ?disabled=${!this.activePresetName} title="Delete current preset" aria-label="Delete Current Preset">Delete</button>
        </div>
        <div>
            <button @click=${this.handleExportKnobs} title="Export current knobs to JSON" aria-label="Export Knobs">Export</button>
            <input type="file" id="import-file-input" @change=${this.handleImportPreset} accept=".json" aria-label="Import Preset File">
            <button @click=${this.triggerImportFile} title="Import knobs from JSON" aria-label="Import Preset">Import</button>
            <button @click=${this.resetAllKnobsToDefault} title="Reset all knobs to default values" aria-label="Reset Knobs">Reset Knobs</button>
        </div>
        ${this.activePresetName ? html`<span class="preset-name-display">Active: ${this.activePresetName}</span>` : ''}
      </div>

      <div id="grid">${this.renderPrompts()}</div>
      <play-pause-button .playbackState=${this.playbackState} @click=${this.handlePlayPause} aria-label=${this.playbackState === 'playing' ? 'Pause music' : 'Play music'}></play-pause-button>
      
      ${this.recordedAudioURL ? html`
        <button class="download-recording-button" @click=${this.handleDownloadRecording} aria-label="Download recorded audio">
            Download Recording
        </button>` : ''}
    `;
  }

  private renderPrompts() {
    return [...this.prompts.values()].map((prompt) => {
      return html`<prompt-controller
        .promptId=${prompt.promptId}
        .filtered=${this.filteredPrompts.has(prompt.text)}
        .cc=${prompt.cc}
        .text=${prompt.text}
        .weight=${prompt.weight}
        .color=${prompt.color}
        .midiDispatcher=${this.midiDispatcher}
        .showCC=${this.showMidi}
        .audioLevel=${this.audioLevel}
        @prompt-changed=${this.handlePromptChanged}>
      </prompt-controller>`;
    });
  }
}

function getInitialPromptsFromStorage(): Map<string, Prompt> {
  const storedPrompts = localStorage.getItem(LOCAL_STORAGE_LAST_ACTIVE_PROMPTS_KEY);
  if (storedPrompts) {
    try {
      const promptsArray = JSON.parse(storedPrompts) as Prompt[];
      // Ensure we have all 16 prompts, even if storage had fewer/more (e.g. from older versions)
      const defaultStructure = buildDefaultPrompts();
      const finalPrompts = new Map<string, Prompt>();
      
      const storedMap = new Map(promptsArray.map(p => [p.promptId, p]));

      defaultStructure.forEach(defaultPrompt => {
        if(storedMap.has(defaultPrompt.promptId)){
            const storedP = storedMap.get(defaultPrompt.promptId)!;
             // Take all fields from storage if available, otherwise from default
            finalPrompts.set(defaultPrompt.promptId, {
                promptId: defaultPrompt.promptId,
                text: storedP.text !== undefined ? storedP.text : defaultPrompt.text,
                weight: storedP.weight !== undefined ? storedP.weight : defaultPrompt.weight,
                cc: storedP.cc !== undefined ? storedP.cc : defaultPrompt.cc,
                color: storedP.color !== undefined ? storedP.color : defaultPrompt.color,
            });
        } else {
            finalPrompts.set(defaultPrompt.promptId, {...defaultPrompt});
        }
      });
      console.log('Loading last active prompts from storage.', finalPrompts);
      return finalPrompts;

    } catch (e) {
      console.error('Failed to parse stored last active prompts, using defaults.', e);
    }
  }
  console.log('No stored last active prompts, using default prompts.');
  return buildDefaultPrompts();
}

function buildDefaultPrompts(): Map<string, Prompt> {
  const prompts = new Map<string, Prompt>();
  // Pick 3 random prompts to start with weight 1, others 0
  const startOnIndices = new Set<number>();
  while(startOnIndices.size < 3) {
    startOnIndices.add(Math.floor(Math.random() * DEFAULT_PROMPTS.length));
  }

  DEFAULT_PROMPTS.forEach((promptData, i) => {
    const promptId = `prompt-${i}`;
    prompts.set(promptId, {
      promptId,
      text: promptData.text,
      weight: startOnIndices.has(i) ? 1 : 0,
      cc: i, // Default CC mapping
      color: promptData.color,
    });
  });
  return prompts;
}


async function main(parent: HTMLElement) {
  const midiDispatcher = new MidiDispatcher();
  const initialPrompts = getInitialPromptsFromStorage();

  const pdjMidi = new PromptDjMidi(initialPrompts, midiDispatcher);
  parent.appendChild(pdjMidi);
}

main(document.body);

declare global {
  interface Window { webkitAudioContext: typeof AudioContext; } // For Safari
  interface HTMLElementTagNameMap {
    'prompt-dj-midi': PromptDjMidi;
    'prompt-controller': PromptController;
    'weight-knob': WeightKnob;
    'play-pause-button': PlayPauseButton;
    'toast-message': ToastMessage
  }
   interface ErrorEvent { // For some reason, TS doesn't always have 'error' on event for MediaRecorder
    error: DOMException;
  }
  interface MIDIConnectionEvent extends Event {
    readonly port: MIDIPort;
  }
}