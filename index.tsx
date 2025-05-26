/**
 * @fileoverview Control real time music with a MIDI controller
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { css, html, LitElement, svg, CSSResultGroup, TemplateResult } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import { classMap } from 'lit/directives/class-map.js';

import { GoogleGenAI, type LiveMusicSession, type LiveMusicServerMessage } from '@google/genai';
import { decode, decodeAudioData } from './utils';
import { getWaveBlob } from 'webm-to-wav-converter';

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
  prompts: Prompt[];
  isFavorite?: boolean;
}

interface ControlChange {
  channel: number;
  cc: number;
  value: number;
}

type PlaybackState = 'stopped' | 'playing' | 'loading' | 'paused';

/**
 * Throttles a callback to be called at most once per `delay` milliseconds.
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
  { color: '#d8ff3e', text: 'Sparkling Arps' }, // Shortened for space
  { color: '#d9b2ff', text: 'Staccato Beats' }, // Shortened
  { color: '#3dffab', text: 'Punchy Kick' },
  { color: '#ffdd28', text: 'Dubstep Wobble' }, // Shortened
  { color: '#ff25f6', text: 'K Pop Hit' }, // Shortened
  { color: '#d8ff3e', text: 'Neo Soul Keys' }, // Shortened
  { color: '#5200ff', text: 'Trip Hop Groove' }, // Shortened
  { color: '#d9b2ff', text: 'Thrash Metal' }, // Shortened
];

// Toast Message component
@customElement('toast-message')
class ToastMessage extends LitElement {
  static override styles = css`
    .toast {
      line-height: 1.6;
      position: fixed;
      top: 80px; /* Adjusted for new top bar */
      left: 50%;
      transform: translateX(-50%);
      background-color: #222; 
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
      z-index: 10000; /* Ensure above other elements */
      box-shadow: 0 4px 15px rgba(0,0,0,0.2);
      border: 1px solid rgba(255,255,255,0.1);
      font-family: 'Google Sans', sans-serif;
    }
    button { /* Close button specific styles */
      border-radius: 50%; width: 24px; height: 24px; aspect-ratio: 1; border: none;
      color: #000; background-color: #ddd; cursor: pointer; display: flex;
      align-items: center; justify-content: center; font-size: 14px; font-weight: bold; padding: 0;
    }
    button:hover { background-color: #ccc; }
    .toast:not(.showing) { transform: translate(-50%, -200%); opacity: 0; pointer-events: none; }
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
    this.message = message; this.showing = true; clearTimeout(this.timeoutId);
    if (duration > 0) { this.timeoutId = window.setTimeout(() => this.hide(), duration); }
  }
  hide() { this.showing = false; }
}

// WeightKnob component
@customElement('weight-knob')
class WeightKnob extends LitElement {
  static override styles = [css`
    :host { 
      cursor: grab; 
      position: relative; 
      width: 100%; 
      height: 100%; /* Allow height to be set by parent */
      display: flex; /* For centering slider track */
      align-items: center; /* For centering slider track */
      justify-content: center; /* For centering slider track */
      flex-shrink: 0; 
      touch-action: none; 
    }
    :host([displayMode="knob"]) {
      aspect-ratio: 1; /* Only for knob mode */
    }
    :host([displayMode="slider"]) {
      /* Slider mode takes full height from prompt-controller */
    }

    svg { position: absolute; top: 0; left: 0; width: 100%; height: 100%; }
    #halo { 
      position: absolute; z-index: -1; top: 0; left: 0; 
      width: 100%; height: 100%; border-radius: 50%; 
      mix-blend-mode: lighten; transform: scale(2); will-change: transform; 
    }
    :host([displayMode="slider"]) #halo { display: none; }
    :host([displayMode="slider"]) svg { display: none; }

    .slider-track {
      width: 12px; 
      height: 100%; 
      background-color: #333;
      border: 1px solid #555;
      border-radius: 6px;
      position: relative;
    }
    .slider-thumb {
      width: 30px; 
      height: 15px; 
      background-color: #ddd;
      border: 1px solid #fff;
      box-shadow: 0 0 5px rgba(255,255,255,0.5);
      border-radius: 3px;
      position: absolute;
      left: 50%;
      /* transform: translateX(-50%); Will be set with bottom */
      cursor: grab;
    }
  `];
  @property({ type: Number }) value = 0; 
  @property({ type: String }) color = '#000'; 
  @property({ type: Number }) audioLevel = 0;
  @property({ type: String, reflect: true }) displayMode: 'knob' | 'slider' = 'knob';

  private dragStartPos = 0; private dragStartValue = 0;
  constructor() { super(); this.handlePointerDown = this.handlePointerDown.bind(this); this.handlePointerMove = this.handlePointerMove.bind(this); this.handlePointerUp = this.handlePointerUp.bind(this); }
  
  private handlePointerDown(e: PointerEvent) { 
    if (e.button !== 0) return; 
    this.dragStartPos = e.clientY; 
    this.dragStartValue = this.value; 
    document.body.classList.add('dragging'); 
    window.addEventListener('pointermove', this.handlePointerMove); 
    window.addEventListener('pointerup', this.handlePointerUp); 
    this.style.cursor = 'grabbing'; 
    if (this.displayMode === 'slider' && e.currentTarget instanceof HTMLElement) {
        const track = e.currentTarget.classList.contains('slider-track') ? e.currentTarget : e.currentTarget.querySelector('.slider-track');
        if (track) {
            const rect = track.getBoundingClientRect();
            const relativeY = e.clientY - rect.top;
            const newValue = (1 - (relativeY / rect.height)) * 2; // Max value is 2
            this.value = Math.max(0, Math.min(2, newValue));
            this.dispatchEvent(new CustomEvent<number>('input', { detail: this.value }));
            this.dragStartValue = this.value; // Update dragStartValue for immediate drag
        }
    }
  }
  private handlePointerMove(e: PointerEvent) { 
    const delta = this.dragStartPos - e.clientY; 
    this.value = this.dragStartValue + delta * (this.displayMode === 'slider' ? 0.02 : 0.01); // Slider more sensitive
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
  private describeArc(centerX: number, centerY: number, startAngle: number, endAngle: number, radius: number ): string { const startX = centerX + radius * Math.cos(startAngle); const startY = centerY + radius * Math.sin(startAngle); const endX = centerX + radius * Math.cos(endAngle); const endY = centerY + radius * Math.sin(endAngle); const largeArcFlag = endAngle - startAngle <= Math.PI ? '0' : '1'; return `M ${startX} ${startY} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${endX} ${endY}`; }
  
  override render() { 
    if (this.displayMode === 'slider') {
      const valuePercentage = (this.value / 2) * 100;
      const thumbStyle = styleMap({
        bottom: `${valuePercentage}%`,
        transform: `translate(-50%, 50%)` // Center thumb horizontally, align bottom of thumb with value point
      });
      return html`
        <div class="slider-track" @pointerdown=${this.handlePointerDown} @wheel=${this.handleWheel}>
          <div class="slider-thumb" style=${thumbStyle}></div>
        </div>
      `;
    }
    // Knob rendering
    const MIN_HALO_SCALE = 1; const MAX_HALO_SCALE = 2; const HALO_LEVEL_MODIFIER = 1; const rotationRange = Math.PI * 2 * 0.75; const minRot = -rotationRange / 2 - Math.PI / 2; const maxRot = rotationRange / 2 - Math.PI / 2; const rot = minRot + (this.value / 2) * (maxRot - minRot); const dotStyle = styleMap({ transform: `translate(40px, 40px) rotate(${rot}rad)` }); let scale = (this.value / 2) * (MAX_HALO_SCALE - MIN_HALO_SCALE); scale += MIN_HALO_SCALE; scale += this.audioLevel * HALO_LEVEL_MODIFIER; const haloStyle = styleMap({ display: this.value > 0 ? 'block' : 'none', background: this.color, transform: `scale(${scale})`, });
    return html`
      <div id="halo" style=${haloStyle}></div>
      <svg viewBox="0 0 80 80"> <ellipse opacity="0.4" cx="40" cy="40" rx="40" ry="40" fill="url(#f1)" /> <g filter="url(#f2)"> <ellipse cx="40" cy="40" rx="29" ry="29" fill="url(#f3)" /> </g> <g filter="url(#f4)"> <circle cx="40" cy="40" r="20.6667" fill="url(#f5)" /> </g> <circle cx="40" cy="40" r="18" fill="url(#f6)" /> <defs> <filter id="f2" x="8.33301" y="10.0488" width="63.333" height="64" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"> <feFlood flood-opacity="0" result="BackgroundImageFix" /> <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" /> <feOffset dy="2" /><feGaussianBlur stdDeviation="1.5" /><feComposite in2="hardAlpha" operator="out" /> <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" /><feBlend mode="normal" in2="BackgroundImageFix" result="shadow1" /> <feBlend mode="normal" in="SourceGraphic" in2="shadow1" result="shape" /> </filter> <filter id="f4" x="11.333" y="19.0488" width="57.333" height="59.334" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"> <feFlood flood-opacity="0" result="BackgroundImageFix" /> <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" /> <feOffset dy="10" /><feGaussianBlur stdDeviation="4" /><feComposite in2="hardAlpha" operator="out" /> <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" /><feBlend mode="normal" in2="BackgroundImageFix" result="shadow1" /> <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" /> <feMorphology radius="5" operator="erode" in="SourceAlpha" result="shadow2" /> <feOffset dy="8" /><feGaussianBlur stdDeviation="3" /><feComposite in2="hardAlpha" operator="out" /> <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" /><feBlend mode="normal" in2="shadow1" result="shadow2" /> <feBlend mode="normal" in="SourceGraphic" in2="shadow2" result="shape" /> </filter> <linearGradient id="f1" x1="40" y1="0" x2="40" y2="80" gradientUnits="userSpaceOnUse"> <stop stop-opacity="0.5" /><stop offset="1" stop-color="white" stop-opacity="0.3" /> </linearGradient> <radialGradient id="f3" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(40 40) rotate(90) scale(29 29)"> <stop offset="0.6" stop-color="white" /><stop offset="1" stop-color="white" stop-opacity="0.7" /> </radialGradient> <linearGradient id="f5" x1="40" y1="19.0488" x2="40" y2="60.3822" gradientUnits="userSpaceOnUse"> <stop stop-color="white" /><stop offset="1" stop-color="#F2F2F2" /> </linearGradient> <linearGradient id="f6" x1="40" y1="21.7148" x2="40" y2="57.7148" gradientUnits="userSpaceOnUse"> <stop stop-color="#EBEBEB" /><stop offset="1" stop-color="white" /> </linearGradient> </defs> </svg>
      <svg viewBox="0 0 80 80" @pointerdown=${this.handlePointerDown} @wheel=${this.handleWheel}> <g style=${dotStyle}> <circle cx="14" cy="0" r="2" fill="#000" /> </g> <path d=${this.describeArc(40, 40, minRot, maxRot, 34.5)} fill="none" stroke="#0003" stroke-width="3" stroke-linecap="round" /> <path d=${this.describeArc(40, 40, minRot, rot, 34.5)} fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" /> </svg>
    `;
  }
}

// Base class for icon buttons. (no changes from original)
class IconButton extends LitElement {
  static override styles = css`
    :host { position: relative; display: flex; align-items: center; justify-content: center; pointer-events: none; }
    :host(:hover) svg { transform: scale(1.2); }
    svg { width: 100%; height: 100%; transition: transform 0.5s cubic-bezier(0.25, 1.56, 0.32, 0.99); }
    .hitbox { pointer-events: all; position: absolute; width: 65%; aspect-ratio: 1; top: 9%; border-radius: 50%; cursor: pointer; }
  ` as CSSResultGroup;
  protected renderIcon() { return svg``; }
  private renderSVG() {
    return html` <svg width="140" height="140" viewBox="0 -10 140 150" fill="none" xmlns="http://www.w3.org/2000/svg"> <rect x="22" y="6" width="96" height="96" rx="48" fill="black" fill-opacity="0.05" /> <rect x="23.5" y="7.5" width="93" height="93" rx="46.5" stroke="black" stroke-opacity="0.3" stroke-width="3" /> <g filter="url(#filter0_ddi_1048_7373)"> <rect x="25" y="9" width="90" height="90" rx="45" fill="white" fill-opacity="0.05" shape-rendering="crispEdges" /> </g> ${this.renderIcon()} <defs> <filter id="filter0_ddi_1048_7373" x="0" y="0" width="140" height="140" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"> <feFlood flood-opacity="0" result="BackgroundImageFix" /> <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" /> <feOffset dy="2" /><feGaussianBlur stdDeviation="4" /><feComposite in2="hardAlpha" operator="out" /> <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" /><feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_1048_7373" /> <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" /> <feOffset dy="16" /><feGaussianBlur stdDeviation="12.5" /><feComposite in2="hardAlpha" operator="out" /> <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" /><feBlend mode="normal" in2="effect1_dropShadow_1048_7373" result="effect2_dropShadow_1048_7373" /> <feBlend mode="normal" in="SourceGraphic" in2="effect2_dropShadow_1048_7373" result="shape" /> <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha" /> <feOffset dy="3" /><feGaussianBlur stdDeviation="1.5" /><feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" /> <feColorMatrix type="matrix" values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.05 0" /><feBlend mode="normal" in2="shape" result="effect3_innerShadow_1048_7373" /> </filter></defs></svg>`;
  }
  override render() { return html`${this.renderSVG()}<div class="hitbox"></div>`; }
}

// PlayPauseButton (no changes from original)
@customElement('play-pause-button')
export class PlayPauseButton extends IconButton {
  @property({ type: String }) playbackState: PlaybackState = 'stopped';
  static override styles = [ IconButton.styles, css` .loader { stroke: #ffffff; stroke-width: 3; stroke-linecap: round; animation: spin linear 1s infinite; transform-origin: center; transform-box: fill-box; } @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(359deg); } } ` ] as CSSResultGroup;
  private renderPause() { return svg`<path d="M75.0037 69V39H83.7537V69H75.0037ZM56.2537 69V39H65.0037V69H56.2537Z" fill="#FEFEFE"/>`; }
  private renderPlay() { return svg`<path d="M60 71.5V36.5L87.5 54L60 71.5Z" fill="#FEFEFE" />`; }
  private renderLoading() { return svg`<path shape-rendering="crispEdges" class="loader" d="M70,74.2L70,74.2c-10.7,0-19.5-8.7-19.5-19.5l0,0c0-10.7,8.7-19.5,19.5-19.5l0,0c10.7,0,19.5,8.7,19.5,19.5l0,0"/>`; }
  override renderIcon() { if (this.playbackState === 'playing') return this.renderPause(); else if (this.playbackState === 'loading') return this.renderLoading(); return this.renderPlay(); }
}

// MidiDispatcher class (no changes from original)
class MidiDispatcher extends EventTarget {
  private access: MIDIAccess | null = null; activeMidiInputId: string | null = null; private initialScanDone = false;
  async getMidiAccess(): Promise<string[]> { if (!navigator.requestMIDIAccess) { console.warn('Web MIDI API not supported'); this.dispatchEvent(new CustomEvent('midinotavailable')); return []; } if (!this.access && !this.initialScanDone) { try { this.access = await navigator.requestMIDIAccess({ sysex: false }); this.initialScanDone = true; } catch (error: unknown) { console.error('MIDI access failed:', error); this.dispatchEvent(new CustomEvent('midinotavailable', {detail: error instanceof Error ? error.message : 'Unknown error'})); return []; } this.access.onstatechange = (event: MIDIConnectionEvent) => { if (!event.port) return; console.log('MIDI state changed:', event.port.name, event.port.type, event.port.state); this.dispatchEvent(new CustomEvent('midideviceschange')); }; } if (!this.access) return []; const inputIds = Array.from(this.access.inputs.keys()); for (const input of this.access.inputs.values()) { input.onmidimessage = (event: MIDIMessageEvent) => { if (input.id !== this.activeMidiInputId) return; const { data } = event; if (!data) { console.error('MIDI message has no data'); return; } const statusByte = data[0]; const channel = statusByte & 0x0f; const messageType = statusByte & 0xf0; const isControlChange = messageType === 0xb0; if (!isControlChange) return; const detail: ControlChange = { cc: data[1], value: data[2], channel }; this.dispatchEvent(new CustomEvent<ControlChange>('cc-message', { detail })); }; } return inputIds; }
  getDeviceName(id: string): string | null { if (!this.access) return null; const input = this.access.inputs.get(id); return input ? input.name : null; }
}

// AudioAnalyser class (no changes from original)
class AudioAnalyser {
  readonly node: AnalyserNode; private readonly freqData: Uint8Array;
  constructor(context: AudioContext) { this.node = context.createAnalyser(); this.node.fftSize = 256; this.node.smoothingTimeConstant = 0.3; this.freqData = new Uint8Array(this.node.frequencyBinCount); }
  getCurrentLevel() { this.node.getByteFrequencyData(this.freqData); const avg = this.freqData.reduce((a, b) => a + b, 0) / this.freqData.length; return avg / 0xff; }
}

// PromptController component
@customElement('prompt-controller')
class PromptController extends LitElement {
  static override styles = css`
    .prompt { 
      width: 100%; height: 100%; 
      display: flex; flex-direction: column; 
      align-items: center; justify-content: space-between; /* Distribute space */
      box-sizing: border-box;
      padding: 5px; /* Padding for content within controller */
    }
    weight-knob { 
      flex-shrink: 0; 
      /* Sizing handled by :host([displayMode]) rules */
    }
    :host([displayMode="knob"]) weight-knob {
      width: 70%; /* Knob specific width */
      /* aspect-ratio: 1; defined in weight-knob */
      margin-bottom: 5px; /* Space below knob */
    }
    :host([displayMode="slider"]) weight-knob {
      width: 100%; /* Slider track area takes what prompt-controller gives */
      height: 100%; /* Slider track area takes what prompt-controller gives */
      flex-grow: 1; /* Allow slider to take up vertical space */
      margin-bottom: 8px; /* Space below slider */
    }

    #midi { 
      font-family: monospace; text-align: center; font-size: 1.3vmin; 
      border: 0.1vmin solid #fff; border-radius: 0.4vmin; 
      padding: 1px 4px; color: #fff; background: #0006; 
      cursor: pointer; visibility: hidden; user-select: none; 
      margin-top: 0.5vmin; 
      white-space: nowrap;
    }
    .learn-mode #midi { color: orange; border-color: orange; } 
    .show-cc #midi { visibility: visible; } 

    #text { 
      font-family: 'Google Sans', sans-serif; font-weight: 500; 
      font-size: 1.5vmin; /* Adjusted for potentially smaller controllers */
      line-height: 1.2;
      max-width: 100%; min-width: 2vmin; 
      padding: 0.1em 0.2em; 
      /* margin-top: 0.5vmin; -> margin handled by justify-content in .prompt */
      flex-shrink: 0; border-radius: 0.25vmin; 
      text-align: center; white-space: normal; /* Allow wrap */
      word-break: break-word; overflow: hidden; 
      border: none; outline: none; -webkit-font-smoothing: antialiased; 
      background: transparent; /* Knobs are on dark bg */
      color: #fff; 
    }
    #text:not(:focus) { text-overflow: ellipsis; } 
    :host([filtered=true]) #text { background: #da2000; color: white; } 

    @media only screen and (max-width: 600px) { 
      #text { font-size: 2vmin; } 
      :host([displayMode="knob"]) weight-knob { width: 60%; }
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
  @property({ type: String, reflect: true }) displayMode: 'knob' | 'slider' = 'knob'; // Added

  @query('weight-knob') private weightInput!: WeightKnob; 
  @query('#text') private textInput!: HTMLInputElement; 
  @property({ type: Object }) midiDispatcher: MidiDispatcher | null = null; 
  @property({ type: Number }) audioLevel = 0; 
  private lastValidText!: string;
  override connectedCallback() { super.connectedCallback(); this.midiDispatcher?.addEventListener('cc-message', this.handleCCMessage.bind(this) as EventListener); }
  override disconnectedCallback(): void { super.disconnectedCallback(); this.midiDispatcher?.removeEventListener('cc-message', this.handleCCMessage.bind(this) as EventListener); }
  private handleCCMessage(e: CustomEvent<ControlChange>) { const { channel, cc, value } = e.detail; if (this.learnMode) { this.cc = cc; this.learnMode = false; this.dispatchPromptChange(); } else if (cc === this.cc) { this.weight = (value / 127) * 2; this.dispatchPromptChange(); } }
  override firstUpdated() { this.textInput.setAttribute('contenteditable', 'plaintext-only'); this.textInput.textContent = this.text; this.lastValidText = this.text; }
  update(changedProperties: Map<string, unknown>) { if (changedProperties.has('showCC') && !this.showCC) this.learnMode = false; if (changedProperties.has('text') && this.textInput && this.textInput.textContent !== this.text) { this.textInput.textContent = this.text; } if (changedProperties.has('learnMode')) { this.requestUpdate(); } super.update(changedProperties); }
  private dispatchPromptChange() { this.dispatchEvent(new CustomEvent<Prompt>('prompt-changed', { detail: { promptId: this.promptId, text: this.text, weight: this.weight, cc: this.cc, color: this.color }, })); }
  private async updateText() { const newText = this.textInput.textContent?.trim(); if (!newText || newText.length === 0) { this.textInput.textContent = this.lastValidText; } else { this.text = newText; this.lastValidText = newText; } this.dispatchPromptChange(); }
  private onFocus() { const selection = window.getSelection(); if (!selection) return; const range = document.createRange(); range.selectNodeContents(this.textInput); selection.removeAllRanges(); selection.addRange(range); }
  private updateWeight() { this.weight = this.weightInput.value; this.dispatchPromptChange(); } private toggleLearnMode() { this.learnMode = !this.learnMode; }
  
  override render() { 
    const classes = classMap({ 'prompt': true, 'learn-mode': this.learnMode, 'show-cc': this.showCC }); 
    return html`<div class=${classes}> 
      <weight-knob 
        id="weight" 
        .value=${this.weight} 
        .color=${this.color} 
        .audioLevel=${this.audioLevel}
        .displayMode=${this.displayMode} 
        @input=${this.updateWeight}>
      </weight-knob> 
      <span 
        id="text" 
        spellcheck="false" 
        @focus=${this.onFocus} 
        @blur=${this.updateText} 
        @keydown=${(e:KeyboardEvent) => {if(e.key === 'Enter'){ e.preventDefault(); this.textInput.blur();}}} 
      ></span> 
      <div 
        id="midi" 
        @click=${this.toggleLearnMode} 
        title=${this.learnMode ? 'Waiting for MIDI CC...' : `Click to learn MIDI CC (Current: ${this.cc})`}> 
        ${this.learnMode ? 'Learn...' : `CC:${this.cc}`} 
      </div> 
    </div>`; 
  }
}

/** The main application component. */
@customElement('prompt-dj-midi')
class PromptDjMidi extends LitElement {
  static override styles = css`
    :host { 
      display: flex;
      flex-direction: column;
      height: 100vh; /* Full viewport height */
      box-sizing: border-box; 
      padding-top: 65px; /* Space for the fixed .top-controls-panel */
      position: relative; 
      background-color: #111; /* Ensure host bg is set */
      overflow: hidden; /* Prevent scrollbars on host due to internal content */
    }
    #background { 
      will-change: background-image; 
      position: absolute; top:0; left:0; 
      height: 100%; width: 100%; 
      z-index: -1; background: #111; 
    }
    toast-message {} /* Component takes care of its own fixed positioning */

    #preset-panel-top {
      padding: 8px 12px;
      background: rgba(25, 25, 25, 0.9);
      backdrop-filter: blur(4px);
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      display: flex;
      flex-wrap: wrap; 
      gap: 12px; /* Gap between groups of controls */
      align-items: flex-start; /* Align groups to top */
      justify-content: center; /* Center groups if they don't fill width */
      flex-shrink: 0; /* Prevent shrinking */
    }
    #preset-panel-top > div { /* Sections within the preset panel */
      display: flex;
      flex-direction: column; 
      gap: 6px; /* Space between controls in a section */
    }
    #preset-panel-top h4 { /* Re-add for section titles if desired */
      margin: 0 0 4px 0;
      font-size: 0.9em;
      color: #ddd;
      font-weight: 500;
    }
    #preset-panel-top label {
      font-size: 0.8rem;
      color: #bbb;
      margin-bottom: 0;
    }
    #preset-panel-top button, #preset-panel-top select {
      padding: 4px 8px;
      font-size: 0.8rem;
      min-width: 120px; /* Ensure buttons/selects are not too small */
    }
    .active-preset-display {
      font-style: italic; color: #ccc; font-size: 0.85rem; margin-top: 5px;
      padding: 6px; background: rgba(0,0,0,0.2); border-radius: 4px;
      text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      max-width: 200px; /* Prevent it from becoming too wide */
    }


    #mixer-area {
      flex-grow: 1; /* Takes remaining vertical space */
      display: flex;
      flex-direction: column;
      align-items: center; /* Center children horizontally */
      justify-content: flex-start; /* Align content to top */
      padding: 15px;
      overflow-y: auto; /* Allow scrolling ONLY for mixer area if content overflows */
      gap: 20px; /* Space between knob section, slider section, and play controls */
      width: 100%;
      box-sizing: border-box;
    }

    #top-knobs-section, #bottom-sliders-section {
      display: grid;
      grid-template-columns: repeat(8, 1fr);
      gap: 12px; /* Space between controllers */
      width: 100%; 
      max-width: 960px; /* Max width for very wide screens */
      box-sizing: border-box;
    }
    #top-knobs-section prompt-controller {
       height: 12vmin; /* Make knobs relatively small */
       min-height: 90px; max-height: 130px;
    }
    #bottom-sliders-section prompt-controller {
       height: 28vmin; /* Make sliders taller */
       min-height: 180px; max-height: 250px;
    }
    
    #playback-controls-section {
      display: flex;
      gap: 8px; /* Adjusted gap for more buttons */
      align-items: center;
      margin-top: 10px; /* Space above play button area */
      flex-shrink: 0; /* Prevent shrinking */
      flex-wrap: wrap; /* Allow buttons to wrap if not enough space */
    }
    play-pause-button { 
      width: 12vmin; 
      min-width: 70px; max-width: 100px;
    }
    /* Ensure all buttons in playback-controls-section have consistent sizing if needed */
    #playback-controls-section button {
        min-width: 80px; /* Example: adjust as needed */
        padding: 5px 10px; /* Example: adjust as needed */
    }
    .download-recording-button { /* Keep specific styling if needed */
        /* padding: 8px 15px; */ /* from original index.css */
    }
    
    /* Hide MIDI select initially if showMidi is false, using Lit's styleMap or direct styling */
    #midi-device-select[style*="display: none"] {
        /* This selector might be too specific depending on how Lit applies styleMap */
        /* It's better to handle visibility in the render method for clarity */
    }
  `;

  @state() private prompts: Map<string, Prompt>;
  private midiDispatcher: MidiDispatcher;
  private audioAnalyser: AudioAnalyser;

  @state() private playbackState: PlaybackState = 'stopped';
  private session!: LiveMusicSession;
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

  @state() private isRecording: boolean = false;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  
  // <<< NEW STATE FOR RECORDING URLS AND CONVERSION STATUS
  @state() private recordedAudioURL_WebM: string | null = null;
  @state() private recordedAudioURL_WAV: string | null = null;
  @state() private isConverting: boolean = false;
  // END OF NEW STATE

  private streamDestination: MediaStreamAudioDestinationNode | null = null;

  @state() private namedPresets: Preset[] = [];
  @state() private activePresetName: string | null = null;
  @query('#import-file-input') private importFileInput!: HTMLInputElement;

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
    this.outputNode.disconnect(); 
    this.outputNode = this.audioContext.createGain();
    this.outputNode.connect(this.audioAnalyser.node);
    this.outputNode.connect(this.audioContext.destination);
    if (this.audioContext.state === 'suspended') { this.audioContext.resume(); }
    if (!this.streamDestination) { 
        this.streamDestination = this.audioContext.createMediaStreamDestination(); 
    }
    this.outputNode.connect(this.streamDestination);
  }

  override async connectedCallback() {
    super.connectedCallback();
    this.loadPresetsFromStorage(); 
    await this.connectToSession();
    await this.setSessionPrompts();
    this.updateAudioLevel(); 
    await this.refreshMidiDeviceList();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.audioLevelRafId) cancelAnimationFrame(this.audioLevelRafId);
    this.midiDispatcher.removeEventListener('midideviceschange', this.handleMidiDevicesChange.bind(this));
    this.session?.close();
    if (this.isRecording && this.mediaRecorder && this.mediaRecorder.state === "recording") {
        this.mediaRecorder.stop();
    }
    // Revoke URLs on disconnect
    if (this.recordedAudioURL_WebM) URL.revokeObjectURL(this.recordedAudioURL_WebM);
    if (this.recordedAudioURL_WAV) URL.revokeObjectURL(this.recordedAudioURL_WAV);
    this.audioContext.close();
  }

  private async connectToSession() { 
    if (this.session && !this.connectionError) {  try {  await this.session.getServerInfo();  return; } catch (e) { console.warn("Session check failed, reconnecting", e); } }
    this.playbackState = 'loading'; this.toastMessage.show('Connecting to music session...', 0); 
    try {
      this.session = await ai.live.music.connect({ model: model, callbacks: {
          onmessage: async (e: LiveMusicServerMessage) => {
            if (e.setupComplete) { this.connectionError = false; this.toastMessage.show('Music session connected!', 2000); if (this.playbackState === 'loading' && this.getPromptsToSend().length > 0) {} else if (this.playbackState !== 'paused' && this.playbackState !== 'stopped' && this.getPromptsToSend().length === 0){ this.pause(); } }
            if (e.filteredPrompt) { this.filteredPrompts = new Set([...this.filteredPrompts, e.filteredPrompt.text || '']); this.toastMessage.show(`Prompt filtered: ${e.filteredPrompt.text} - ${e.filteredPrompt.filteredReason}`, 5000); this.requestUpdate(); }
            if (e.serverContent?.audioChunks !== undefined) { if (this.playbackState === 'paused' || this.playbackState === 'stopped') return; const audioBuffer = await decodeAudioData( decode(e.serverContent?.audioChunks[0].data), this.audioContext, 48000, 2, ); const source = this.audioContext.createBufferSource(); source.buffer = audioBuffer; source.connect(this.outputNode); if (this.nextStartTime === 0) {  this.nextStartTime = this.audioContext.currentTime + this.bufferTime; setTimeout(() => { if(this.playbackState === 'loading') this.playbackState = 'playing'; }, this.bufferTime * 1000); } if (this.nextStartTime < this.audioContext.currentTime) { console.warn('Buffer underrun, resetting start time.'); this.toastMessage.show('Network latency detected, re-buffering...', 2000); this.playbackState = 'loading';  this.nextStartTime = this.audioContext.currentTime + this.bufferTime;  } source.start(this.nextStartTime); this.nextStartTime += audioBuffer.duration; }
          },
          onerror: (errEvent: ErrorEvent) => { console.error('LiveMusicSession error:', errEvent); this.connectionError = true; this.stop(true);  this.toastMessage.show(`Connection error: ${errEvent.message || 'Please restart audio.'}`, 5000); },
          onclose: (closeEvent: CloseEvent) => { console.warn('LiveMusicSession closed:', closeEvent); if (!this.connectionError) {  this.toastMessage.show('Music session closed.', 3000); } this.connectionError = true;  this.stop(true);  },
        },
      });
    } catch (error: unknown) { console.error("Failed to connect to session:", error); this.toastMessage.show(`Failed to connect: ${error instanceof Error ? error.message : 'Unknown error'}`, 5000); this.connectionError = true; this.playbackState = 'stopped'; }
  }

  private getPromptsToSend(): Prompt[] { return Array.from(this.prompts.values()).filter((p) => !this.filteredPrompts.has(p.text) && p.weight > 0); }

  private setSessionPrompts = throttle(async () => { 
    if (this.connectionError && (this.playbackState === 'playing' || this.playbackState === 'loading')) { this.toastMessage.show('No connection. Reconnecting...', 3000); await this.connectToSession();  if (this.connectionError) { this.pause(); return; } }
    const promptsToSend = this.getPromptsToSend(); if (promptsToSend.length === 0 && (this.playbackState === 'playing' || this.playbackState === 'loading')) { this.toastMessage.show('Add weight to a prompt!', 3000); this.pause(); return; }
    if (this.playbackState === 'stopped' || this.playbackState === 'paused') { return; } if (!this.session || this.connectionError) { return; }
    try { await this.session.setWeightedPrompts({ weightedPrompts: promptsToSend }); const currentActiveTexts = new Set(promptsToSend.map(p => p.text)); this.filteredPrompts = new Set([...this.filteredPrompts].filter(fp => currentActiveTexts.has(fp))); } catch (e: unknown) { this.toastMessage.show(`Error setting prompts: ${e instanceof Error ? e.message : 'Unknown'}`, 4000); console.error("setWeightedPrompts error:", e); this.pause();  }
  }, 200);

  private updateAudioLevel() { this.audioLevel = this.audioAnalyser.getCurrentLevel(); this.audioLevelRafId = requestAnimationFrame(this.updateAudioLevel); }

  private handlePromptChanged(e: CustomEvent<Prompt>) {
    const changedPrompt = e.detail; const prompt = this.prompts.get(changedPrompt.promptId); if (!prompt) { console.error('Prompt not found:', changedPrompt.promptId); return; }
    const updatedPrompt = { ...prompt, text: changedPrompt.text, weight: changedPrompt.weight, cc: changedPrompt.cc };
    const newPrompts = new Map(this.prompts); newPrompts.set(prompt.promptId, updatedPrompt);
    this.setPrompts(newPrompts, false); 
  }

  private setPrompts(newPrompts: Map<string, Prompt>, fromPresetLoad: boolean = false) {
    this.prompts = newPrompts; this.setLastActivePromptsToLocalStorage(this.prompts);
    this.requestUpdate(); this.setSessionPrompts(); 
  }

  private readonly makeBackground = throttle(() => { 
    const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1); const MAX_WEIGHT = 0.5; const MAX_ALPHA = 0.6; const bg: string[] = []; [...this.prompts.values()].forEach((p, i) => { const alphaPct = clamp01(p.weight / MAX_WEIGHT) * MAX_ALPHA; const alpha = Math.round(alphaPct * 0xff).toString(16).padStart(2, '0'); const stop = p.weight / 2; const x = (i % 4) / 3; const y = Math.floor(i / 4) / 3; const s = `radial-gradient(circle at ${x * 100}% ${y * 100}%, ${p.color}${alpha} 0px, ${p.color}00 ${stop * 100}%)`; bg.push(s); }); return bg.join(', ');
  }, 30);

  private async play() { 
    if (this.audioContext.state === 'suspended') { await this.audioContext.resume(); } this.setupAudioNodes(); 
    if (this.connectionError) { this.toastMessage.show('Reconnecting before playing...', 2000); await this.connectToSession(); if (this.connectionError) { this.toastMessage.show('Connection failed. Cannot play.', 3000); this.playbackState = 'stopped';  return; } }
    const promptsToSend = this.getPromptsToSend(); if (promptsToSend.length === 0) { this.toastMessage.show('Turn up a knob!', 3000); this.playbackState = 'paused';  return; }
    this.playbackState = 'loading';  this.outputNode.gain.setValueAtTime(0, this.audioContext.currentTime);  this.outputNode.gain.linearRampToValueAtTime(1, this.audioContext.currentTime + 0.2);
    await this.setSessionPrompts();
    this.session.play();
  }

  private pause() { 
    if (this.playbackState !== 'playing' && this.playbackState !== 'loading') return;
    this.session?.pause();  this.outputNode.gain.setValueAtTime(this.outputNode.gain.value, this.audioContext.currentTime); this.outputNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.2); 
    this.playbackState = 'paused';
    this.nextStartTime = 0; 
  }

  private stop(isErrorStop: boolean = false) {
    this.session?.stop(); this.outputNode.gain.setValueAtTime(this.outputNode.gain.value, this.audioContext.currentTime); this.outputNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.1);
    this.playbackState = 'stopped'; this.nextStartTime = 0; 
  }

  private async handlePlayPause() { 
    if (this.audioContext.state === 'suspended') { await this.audioContext.resume().catch(err => console.error("AudioContext resume failed:", err)); }
    switch (this.playbackState) { case 'playing': this.pause(); break; case 'paused': case 'stopped': await this.play(); break; case 'loading':  this.stop(); break; }
  }

  private handleToggleRecording() {
    if (this.isRecording) {
      this.stopIndependentRecording();
    } else {
      this.startIndependentRecording();
    }
  }

  private startIndependentRecording() {
    if (!this.streamDestination) {
      console.error("Stream destination not available for recording.");
      this.toastMessage.show("Error: Cannot start recording. Audio setup issue.", 3000);
      return;
    }

    // Clear any previously recorded URLs and reset states
    if (this.recordedAudioURL_WebM) URL.revokeObjectURL(this.recordedAudioURL_WebM);
    if (this.recordedAudioURL_WAV) URL.revokeObjectURL(this.recordedAudioURL_WAV);
    this.recordedAudioURL_WebM = null;
    this.recordedAudioURL_WAV = null;
    this.recordedChunks = [];
    this.isConverting = false; // Ensure conversion status is reset

    try {
      const options: { mimeType?: string } = { mimeType: 'audio/webm;codecs=opus' };
      if (!MediaRecorder.isTypeSupported(options.mimeType || '')) {
        console.warn(`${options.mimeType} not supported, trying default audio/webm.`);
        options.mimeType = 'audio/webm';
         if (!MediaRecorder.isTypeSupported(options.mimeType || '')) {
            console.warn(`${options.mimeType} also not supported, trying browser default.`);
            delete options.mimeType;
         }
      }
      this.mediaRecorder = new MediaRecorder(this.streamDestination.stream, options);
    } catch (e: unknown) {
      console.error("MediaRecorder setup failed:", e);
      this.toastMessage.show(`Recording setup failed: ${e instanceof Error ? e.message : 'Unknown'}`, 4000);
      return;
    }

    this.mediaRecorder.ondataavailable = (event: BlobEvent) => {
      if (event.data.size > 0) {
        this.recordedChunks.push(event.data);
      }
    };

    this.mediaRecorder.onstop = async () => { // <<< MADE ASYNC FOR AWAIT
      if (this.recordedChunks.length > 0) {
        const webmBlob = new Blob(this.recordedChunks, { type: this.mediaRecorder?.mimeType || 'audio/webm' });
        
        // Create URL for WebM
        if (this.recordedAudioURL_WebM) URL.revokeObjectURL(this.recordedAudioURL_WebM);
        this.recordedAudioURL_WebM = URL.createObjectURL(webmBlob);
        
        this.toastMessage.show("WebM recording finished. Converting to WAV...", 0); // No auto-hide
        this.isConverting = true;
        this.recordedAudioURL_WAV = null; // Reset WAV URL while converting
        this.requestUpdate();

        try {
          const wavBlob = await this.convertWebMToWAV(webmBlob); // <<< CONVERSION HAPPENS HERE
          if (this.recordedAudioURL_WAV) URL.revokeObjectURL(this.recordedAudioURL_WAV); // Should be null
          this.recordedAudioURL_WAV = URL.createObjectURL(wavBlob);
          this.toastMessage.show("Conversion to WAV complete. Downloads ready.", 4000);
        } catch (error) {
          console.error("Failed to convert WebM to WAV:", error);
          this.toastMessage.show(`WAV conversion failed: ${error instanceof Error ? error.message : 'Unknown error'}`, 5000);
          this.recordedAudioURL_WAV = null;
        } finally {
          this.isConverting = false;
          this.requestUpdate();
        }
      } else {
        // No data recorded, clear any existing URLs
        if (this.recordedAudioURL_WebM) URL.revokeObjectURL(this.recordedAudioURL_WebM);
        if (this.recordedAudioURL_WAV) URL.revokeObjectURL(this.recordedAudioURL_WAV);
        this.recordedAudioURL_WebM = null;
        this.recordedAudioURL_WAV = null;
        this.toastMessage.show("Recording stopped. No audio data captured.", 3000);
      }
      this.isRecording = false;
      this.requestUpdate(); 
    };

    this.mediaRecorder.onerror = (event: Event) => {
        const errorEvent = event as MediaRecorderErrorEvent;
        console.error("MediaRecorder error:", errorEvent.error);
        this.toastMessage.show(`Recording error: ${errorEvent.error?.name} - ${errorEvent.error?.message || 'Unknown'}`, 4000);
        this.isRecording = false;
        this.isConverting = false; // Stop conversion if recording errors out
        if (this.recordedAudioURL_WebM) URL.revokeObjectURL(this.recordedAudioURL_WebM);
        if (this.recordedAudioURL_WAV) URL.revokeObjectURL(this.recordedAudioURL_WAV);
        this.recordedAudioURL_WebM = null;
        this.recordedAudioURL_WAV = null;
        this.recordedChunks = [];
        this.requestUpdate();
    };
    
    this.mediaRecorder.start();
    this.isRecording = true;
    this.toastMessage.show("Recording started...", 2000);
    this.requestUpdate();
  }

  private stopIndependentRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state === "recording") {
      this.mediaRecorder.stop();
    } else {
      this.isRecording = false; 
      this.isConverting = false; // If somehow stop is called without active recording
      this.toastMessage.show("Recording was not active or already stopped.", 2000);
      this.requestUpdate();
    }
  }

  private triggerDownload(url: string | null, filename: string) { if (!url) { this.toastMessage.show("No recording data to download.", 3000); return; } const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a); }
  
  // <<< NEW DOWNLOAD HANDLERS
  private handleDownloadWebM() {
    if (!this.recordedAudioURL_WebM) {
      this.toastMessage.show("No WebM recording available.", 3000);
      return;
    }
    const filename = `PromptDJ_Recording_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.webm`;
    this.triggerDownload(this.recordedAudioURL_WebM, filename);
    this.toastMessage.show(`Downloading WebM: ${filename}`, 3000);
  }

  private handleDownloadWAV() {
    if (!this.recordedAudioURL_WAV) {
      this.toastMessage.show("WAV recording not ready or conversion failed.", 3000);
      return;
    }
    const filename = `PromptDJ_Recording_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.wav`;
    this.triggerDownload(this.recordedAudioURL_WAV, filename);
    this.toastMessage.show(`Downloading WAV: ${filename}`, 3000);
  }
  // END OF NEW DOWNLOAD HANDLERS

  private async refreshMidiDeviceList() { 
    try { const inputIds = await this.midiDispatcher.getMidiAccess(); this.midiInputIds = inputIds; let newActiveId = this.activeMidiInputId; if (this.activeMidiInputId && !inputIds.includes(this.activeMidiInputId)) { newActiveId = inputIds.length > 0 ? inputIds[0] : null; this.toastMessage.show(newActiveId ? `MIDI changed to ${this.midiDispatcher.getDeviceName(newActiveId)}` : "Active MIDI disconnected.", 3000); } else if (!this.activeMidiInputId && inputIds.length > 0) { newActiveId = inputIds[0];  } else if (inputIds.length === 0) { newActiveId = null; } if (newActiveId !== this.activeMidiInputId) { this.activeMidiInputId = newActiveId; } this.midiDispatcher.activeMidiInputId = this.activeMidiInputId;  this.requestUpdate(); 
    } catch (e: unknown) { this.toastMessage.show(`Could not get MIDI: ${e instanceof Error ? e.message : 'Unknown'}`, 3000); this.midiInputIds = []; this.activeMidiInputId = null; this.midiDispatcher.activeMidiInputId = null; this.requestUpdate(); }
  }
  private async toggleShowMidi() { this.showMidi = !this.showMidi; if (this.showMidi && this.midiInputIds.length === 0) { await this.refreshMidiDeviceList(); } }
  private handleMidiInputChange(event: Event) { const selectElement = event.target as HTMLSelectElement; const newMidiId = selectElement.value; this.activeMidiInputId = newMidiId !== "" ? newMidiId : null; this.midiDispatcher.activeMidiInputId = this.activeMidiInputId; if(this.activeMidiInputId) { this.toastMessage.show(`MIDI set to: ${this.midiDispatcher.getDeviceName(this.activeMidiInputId)}`, 2000); } this.requestUpdate();  }
  private async handleMidiDevicesChange() { this.toastMessage.show("MIDI devices changed. Refreshing...", 2000); await this.refreshMidiDeviceList();  }

  private loadPresetsFromStorage() {
    const storedPresets = localStorage.getItem(LOCAL_STORAGE_PRESETS_KEY);
    if (storedPresets) {
      try {
        this.namedPresets = (JSON.parse(storedPresets) as Preset[]).map(p => ({...p, isFavorite: p.isFavorite || false }));
      } catch (e) { console.error("Failed to parse stored presets:", e); this.namedPresets = []; this.toastMessage.show("Error loading presets.", 3000); }
    }
  }
  private savePresetsToStorage() { try { localStorage.setItem(LOCAL_STORAGE_PRESETS_KEY, JSON.stringify(this.namedPresets)); } catch (e) { console.error("Failed to save presets:", e); this.toastMessage.show("Error saving presets.", 4000); } }
  private setLastActivePromptsToLocalStorage(promptsToSave: Map<string, Prompt>) { try { const storablePrompts = Array.from(promptsToSave.values()); localStorage.setItem(LOCAL_STORAGE_LAST_ACTIVE_PROMPTS_KEY, JSON.stringify(storablePrompts)); } catch (e) { console.error("Failed to save last active prompts:", e); } }

  private handleSavePresetAs() {
    const name = prompt("Enter preset name:", this.activePresetName || "My Preset"); if (!name) return;
    const currentPromptsArray = Array.from(this.prompts.values()).map(p => ({...p})); 
    const newPreset: Preset = { name, prompts: currentPromptsArray, isFavorite: false }; 
    const existingPresetIndex = this.namedPresets.findIndex(p => p.name === name);
    if (existingPresetIndex !== -1) { if (!confirm(`Preset "${name}" already exists. Overwrite?`)) { return; } this.namedPresets.splice(existingPresetIndex, 1, newPreset);  } else { this.namedPresets.push(newPreset); }
    this.namedPresets.sort((a, b) => a.name.localeCompare(b.name));  this.activePresetName = name; this.savePresetsToStorage(); this.toastMessage.show(`Preset "${name}" saved.`, 2000); this.requestUpdate(); 
  }
  private handleSaveCurrentPreset() {
    if (!this.activePresetName) { this.handleSavePresetAs(); return; }
    const presetIndex = this.namedPresets.findIndex(p => p.name === this.activePresetName);
    if (presetIndex === -1) { this.toastMessage.show(`Error: Active preset "${this.activePresetName}" not found. Use "Save As..."`, 3000); this.activePresetName = null;  this.requestUpdate(); return; }
    this.namedPresets[presetIndex].prompts = Array.from(this.prompts.values()).map(p => ({...p})); 
    this.savePresetsToStorage(); this.toastMessage.show(`Preset "${this.activePresetName}" updated.`, 2000); this.requestUpdate(); 
  }
  private handleLoadPreset(event: Event) {
    const select = event.target as HTMLSelectElement; const name = select.value; if (!name) { this.activePresetName = null; this.requestUpdate(); return; }
    const preset = this.namedPresets.find(p => p.name === name);
    if (preset) {
      const newPromptsMap = new Map<string, Prompt>(); const defaultStructure = buildDefaultPrompts(); const presetPromptsMap = new Map(preset.prompts.map(p => [p.promptId, p]));
      defaultStructure.forEach(defaultPrompt => { const loadedPromptData = presetPromptsMap.get(defaultPrompt.promptId); if (loadedPromptData) { newPromptsMap.set(defaultPrompt.promptId, {...defaultPrompt, ...loadedPromptData}); } else { newPromptsMap.set(defaultPrompt.promptId, {...defaultPrompt, weight: 0 });  } });
      this.setPrompts(newPromptsMap, true);  this.activePresetName = name; this.filteredPrompts.clear();  this.setSessionPrompts();  this.toastMessage.show(`Preset "${name}" loaded.`, 2000);
    } else { this.toastMessage.show(`Preset "${name}" not found.`, 3000); this.activePresetName = null;  } this.requestUpdate();
  }
  private handleDeleteCurrentPreset() {
    if (!this.activePresetName) { this.toastMessage.show("No active preset to delete.", 2000); return; }
    if (!confirm(`Delete preset "${this.activePresetName}"?`)) { return; }
    const deletedName = this.activePresetName; this.namedPresets = this.namedPresets.filter(p => p.name !== this.activePresetName);
    this.activePresetName = null; this.savePresetsToStorage(); this.toastMessage.show(`Preset "${deletedName}" deleted.`, 2000); this.requestUpdate();
  }
  private handleToggleFavorite() {
    if (!this.activePresetName) return;
    const preset = this.namedPresets.find(p => p.name === this.activePresetName);
    if (preset) {
        preset.isFavorite = !preset.isFavorite;
        this.savePresetsToStorage();
        this.toastMessage.show(preset.isFavorite ? `"${preset.name}" marked as favorite.` : `"${preset.name}" removed from favorites.`, 2000);
        this.requestUpdate();
    }
  }
  private handleExportKnobs() { const dataStr = JSON.stringify({ name: this.activePresetName || "current-knobs", prompts: Array.from(this.prompts.values()) }, null, 2); const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr); const exportFileDefaultName = `${(this.activePresetName || 'current-knobs').replace(/\s+/g, '_')}.json`; this.triggerDownload(dataUri, exportFileDefaultName); this.toastMessage.show(`Exported as ${exportFileDefaultName}`, 2000); }
  private triggerImportFile() { this.importFileInput.click(); }
  private async handleImportPreset(event: Event) { 
    const fileInput = event.target as HTMLInputElement; const file = fileInput.files?.[0]; if (!file) return;
    try {
      const fileContent = await file.text(); const importedData = JSON.parse(fileContent);
      let importedPromptsArray: Prompt[]; let suggestedName = file.name.replace(/\.json$/, "").replace(/_/g, " "); let isFavorite = false;
      if (importedData.prompts && Array.isArray(importedData.prompts)) { importedPromptsArray = importedData.prompts as Prompt[]; if (typeof importedData.name === 'string') suggestedName = importedData.name; if(typeof importedData.isFavorite === 'boolean') isFavorite = importedData.isFavorite; } else if (Array.isArray(importedData)) {  importedPromptsArray = importedData as Prompt[]; } else { throw new Error("Invalid preset file format."); }
      if (!importedPromptsArray.every(p => p.promptId && p.text != null && p.weight != null && p.cc != null && p.color != null)) { throw new Error("Preset file has invalid prompt data."); }
      const name = prompt("Enter name for imported preset:", suggestedName); if (!name) { fileInput.value = '';  return; }
      const finalPromptsForPreset: Prompt[] = []; const defaultStructureArray = Array.from(buildDefaultPrompts().values());
      defaultStructureArray.forEach((defaultP, index) => { const importedPForThisSlot = importedPromptsArray.find(ip => ip.promptId === defaultP.promptId) ||  (index < importedPromptsArray.length ? importedPromptsArray[index] : undefined); if (importedPForThisSlot) { finalPromptsForPreset.push({ ...defaultP,  text: importedPForThisSlot.text, weight: importedPForThisSlot.weight, cc: importedPForThisSlot.cc, color: importedPForThisSlot.color || defaultP.color, }); } else { finalPromptsForPreset.push({...defaultP, weight: 0});  } });
      const newPreset: Preset = { name, prompts: finalPromptsForPreset, isFavorite }; const existingPresetIndex = this.namedPresets.findIndex(p => p.name === name);
      if (existingPresetIndex !== -1) { if (!confirm(`Preset "${name}" already exists. Overwrite?`)) { fileInput.value = '';  return; } this.namedPresets.splice(existingPresetIndex, 1, newPreset); } else { this.namedPresets.push(newPreset); }
      this.namedPresets.sort((a, b) => a.name.localeCompare(b.name)); this.savePresetsToStorage(); 
      this.toastMessage.show(`Preset "${name}" imported. You can now load it.`, 3000); this.requestUpdate();
    } catch (e: unknown) { console.error("Failed to import preset:", e); this.toastMessage.show(`Error importing: ${e instanceof Error ? e.message : 'Unknown'}`, 4000); } finally { fileInput.value = '';  }
  }
  private resetAllKnobsToDefault() { if (confirm("Reset all knobs to default? This won't affect saved presets.")) { const defaultPromptsMap = buildDefaultPrompts(); this.setPrompts(defaultPromptsMap, true);  this.activePresetName = null;  this.filteredPrompts.clear(); this.toastMessage.show("Knobs reset to default.", 2000); this.requestUpdate(); } }
  private isCurrentPresetUnsaved(): boolean { if (!this.activePresetName) return false; const activePresetInStorage = this.namedPresets.find(p => p.name === this.activePresetName); if (!activePresetInStorage) return true;  const currentPromptsArray = Array.from(this.prompts.values()); if (currentPromptsArray.length !== activePresetInStorage.prompts.length) return true; for (let i = 0; i < currentPromptsArray.length; i++) { const pCurrent = currentPromptsArray[i]; const pStored = activePresetInStorage.prompts.find(p => p.promptId === pCurrent.promptId); if (!pStored) return true;  if (pCurrent.text !== pStored.text || Math.abs(pCurrent.weight - pStored.weight) > 0.001 || pCurrent.cc !== pStored.cc || pCurrent.color !== pCurrent.color) { return true;  } } return false;  }

  private async convertWebMToWAV(webmBlob: Blob): Promise<Blob> {
    try {
      const arrayBuffer = await webmBlob.arrayBuffer();
      const wavBlob = await getWaveBlob(new Blob([arrayBuffer]), false);
      return new Blob([wavBlob], { type: 'audio/wav' });
    } catch (error) {
      console.error('WAV conversion failed:', error);
      throw error;
    }
  }

  override render() {
    const bgStyle = styleMap({ backgroundImage: this.makeBackground() });
    const currentPresetIsModified = this.isCurrentPresetUnsaved();
    const activePresetObj = this.namedPresets.find(p => p.name === this.activePresetName);
    const activePresetIsFavorite = activePresetObj?.isFavorite || false;

    const sortedPresetOptions = this.namedPresets
        .sort((a,b) => { 
            if (a.isFavorite && !b.isFavorite) return -1;
            if (!a.isFavorite && b.isFavorite) return 1;
            return a.name.localeCompare(b.name);
        });
    
    const placeholderOptionLabel = this.activePresetName
        ? `${activePresetIsFavorite ? '⭐ ' : ''}${this.activePresetName}${currentPresetIsModified ? "*" : ""}`
        : "Load Preset...";

    return html`
      <div id="background" style=${bgStyle}></div>
      <toast-message></toast-message>
      
      <!-- MIDI Controls Panel (Fixed Top) -->
      <div class="top-controls-panel" role="toolbar" aria-label="MIDI Controls">
        <div>
          <button 
            @click=${this.toggleShowMidi} 
            class=${this.showMidi ? 'active' : ''} 
            aria-pressed=${this.showMidi} 
            aria-label="Toggle MIDI Controls">MIDI
          </button>
          <select 
            id="midi-device-select"
            @change=${this.handleMidiInputChange}
            .value=${this.activeMidiInputId || ''}
            style=${styleMap({ display: this.showMidi ? '' : 'none' })}
            aria-label="Select MIDI Device">
            ${this.midiInputIds.length === 0
              ? html`<option value="" disabled .selected=${this.activeMidiInputId === null}>No MIDI devices found</option>`
              : html`
                  <option value="" ?selected=${this.activeMidiInputId === null} ?disabled=${this.activeMidiInputId !== null && this.midiInputIds.length > 0}>
                    -- Select MIDI --
                  </option>
                  ${this.midiInputIds.map(id =>
                    html`<option value=${id} .selected=${id === this.activeMidiInputId}>
                            ${this.midiDispatcher.getDeviceName(id)}
                         </option>`
                  )}
                `}
          </select>
        </div>
      </div>
      
      <!-- Preset Panel -->
      <div id="preset-panel-top" role="navigation" aria-label="Preset Controls">
        <div>
          <h4>Presets</h4>
          <select id="preset-load-select" @change=${this.handleLoadPreset} .value=${this.activePresetName || ""} aria-label="Load Preset">
              <option value="" ?selected=${!this.activePresetName} disabled>${placeholderOptionLabel}</option>
              ${sortedPresetOptions.map(p => html`<option value=${p.name} ?selected=${p.name === this.activePresetName}>${p.isFavorite ? '⭐ ' : ''}${p.name}</option>`)}
          </select>
          <button @click=${this.handleSaveCurrentPreset} title="Save changes to current preset" aria-label="Save Current Preset" ?disabled=${!this.activePresetName && !currentPresetIsModified}>Save</button>
          <button @click=${this.handleSavePresetAs} title="Save current knobs as a new preset" aria-label="Save Preset As">Save As...</button>
          <button @click=${this.handleToggleFavorite} ?disabled=${!this.activePresetName} title="Toggle favorite status">
            ${activePresetIsFavorite ? 'Unfavorite ⭐' : 'Favorite ☆'}
          </button>
          <button @click=${this.handleDeleteCurrentPreset} ?disabled=${!this.activePresetName} title="Delete current preset" aria-label="Delete Current Preset">Delete</button>
        </div>
        <div>
            <h4>File</h4>
            <button @click=${this.handleExportKnobs} title="Export current knobs to JSON" aria-label="Export Knobs">Export</button>
            <input type="file" id="import-file-input" @change=${this.handleImportPreset} accept=".json" aria-label="Import Preset File">
            <button @click=${this.triggerImportFile} title="Import knobs from JSON" aria-label="Import Preset">Import</button>
        </div>
        <div>
            <h4>Utility</h4>
            <button @click=${this.resetAllKnobsToDefault} title="Reset all knobs to default values" aria-label="Reset Knobs">Reset All</button>
        </div>
        <div id="playback-controls-section">
            <h4>Playback & Record</h4>
            <button @click=${this.handlePlayPause} title="Play/Pause music" aria-label="Play/Pause">
                ${this.playbackState === 'playing' ? 'Pause' : this.playbackState === 'loading' ? 'Loading...' : 'Play'}
            </button>
            <button 
                @click=${this.handleToggleRecording}
                class=${classMap({ active: this.isRecording})}
                title=${this.isRecording ? "Stop Recording" : "Start Recording"}
                aria-label=${this.isRecording ? "Stop Recording" : "Start Recording"}>
                ${this.isRecording ? 'Stop Rec' : 'Record'}
            </button>
            <button 
                class="download-recording-button" 
                @click=${this.handleDownloadWebM}
                ?disabled=${!this.recordedAudioURL_WebM || this.isRecording || this.isConverting}
                title="Download WebM recording">
                Download WebM
            </button>
            <button 
                class="download-recording-button" 
                @click=${this.handleDownloadWAV}
                ?disabled=${!this.recordedAudioURL_WAV || this.isRecording || this.isConverting}
                title="Download WAV recording">
                ${this.isConverting ? 'Converting...' : 'Download WAV'}
            </button>
        </div>
        ${this.activePresetName ? html`
            <div class="active-preset-display">
              Active: ${activePresetIsFavorite ? '⭐ ' : ''}${this.activePresetName}${currentPresetIsModified ? " (modified)" : ""}
            </div>
          ` : ''}
      </div>

      <!-- Mixer Area -->
      <div id="mixer-area" role="main">
        <div id="top-knobs-section">${this.renderKnobs()}</div>
        <div id="bottom-sliders-section">${this.renderSliders()}</div>
      </div>
    `;
  }

  private renderKnobs() {
    return [...this.prompts.values()].slice(0, 8).map((prompt) => {
      return html`<prompt-controller
        .promptId=${prompt.promptId} .filtered=${this.filteredPrompts.has(prompt.text)} .cc=${prompt.cc}
        .text=${prompt.text} .weight=${prompt.weight} .color=${prompt.color}
        .midiDispatcher=${this.midiDispatcher} .showCC=${this.showMidi} .audioLevel=${this.audioLevel}
        displayMode="knob"
        @prompt-changed=${this.handlePromptChanged}>
      </prompt-controller>`;
    });
  }
  private renderSliders() {
    return [...this.prompts.values()].slice(8, 16).map((prompt) => {
      if (!prompt) return html``; 
      return html`<prompt-controller
        .promptId=${prompt.promptId} .filtered=${this.filteredPrompts.has(prompt.text)} .cc=${prompt.cc}
        .text=${prompt.text} .weight=${prompt.weight} .color=${prompt.color}
        .midiDispatcher=${this.midiDispatcher} .showCC=${this.showMidi} .audioLevel=${this.audioLevel}
        displayMode="slider"
        @prompt-changed=${this.handlePromptChanged}>
      </prompt-controller>`;
    });
  }
}

function getInitialPromptsFromStorage(): Map<string, Prompt> {
  const storedPromptsJson = localStorage.getItem(LOCAL_STORAGE_LAST_ACTIVE_PROMPTS_KEY); const defaultStructure = buildDefaultPrompts();
  if (storedPromptsJson) { try { const storedPromptsArray = JSON.parse(storedPromptsJson) as Prompt[]; const finalPrompts = new Map<string, Prompt>(); const storedMap = new Map(storedPromptsArray.map(p => [p.promptId, p])); defaultStructure.forEach((defaultPrompt, promptId) => { const storedP = storedMap.get(promptId); if (storedP) { finalPrompts.set(promptId, { promptId: defaultPrompt.promptId,  text: typeof storedP.text === 'string' ? storedP.text : defaultPrompt.text, weight: typeof storedP.weight === 'number' ? storedP.weight : defaultPrompt.weight, cc: typeof storedP.cc === 'number' ? storedP.cc : defaultPrompt.cc, color: typeof storedP.color === 'string' ? storedP.color : defaultPrompt.color, }); } else { finalPrompts.set(promptId, {...defaultPrompt}); } }); console.log('Loading last active prompts.', finalPrompts); return finalPrompts; } catch (e) { console.error('Failed to parse stored prompts, using defaults.', e); } }
  console.log('No stored prompts, using defaults.'); return defaultStructure;
}
function buildDefaultPrompts(): Map<string, Prompt> {
  const prompts = new Map<string, Prompt>(); DEFAULT_PROMPTS.forEach((promptData, i) => { const promptId = `prompt-${i}`; prompts.set(promptId, { promptId, text: promptData.text, weight: 0,  cc: i,  color: promptData.color, }); }); return prompts;
}

async function main(parent: HTMLElement) {
  const midiDispatcher = new MidiDispatcher();
  const initialPrompts = getInitialPromptsFromStorage();
  const pdjMidi = new PromptDjMidi(initialPrompts, midiDispatcher);
  parent.appendChild(pdjMidi);
}
main(document.body);

declare global {
  interface Window { webkitAudioContext: typeof AudioContext; } 
  interface HTMLElementTagNameMap { 'prompt-dj-midi': PromptDjMidi; 'prompt-controller': PromptController; 'weight-knob': WeightKnob; 'play-pause-button': PlayPauseButton; 'toast-message': ToastMessage }
  interface MIDIConnectionEvent extends Event { readonly port: MIDIPort | null; }
  interface MediaRecorderErrorEvent extends Event {
    readonly error: DOMException;
  }
  interface BlobEvent extends Event {
    readonly data: Blob;
    readonly timecode: DOMHighResTimeStamp;
  }
}