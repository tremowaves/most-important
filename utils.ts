/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import {Blob} from '@google/genai';

function encode(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function createBlob(data: Float32Array): Blob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const buffer = ctx.createBuffer(
    numChannels,
    data.length / 2 / numChannels, 
    sampleRate,
  );
  const dataInt16 = new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2);
  const l = dataInt16.length;
  const dataFloat32 = new Float32Array(l);
  for (let i = 0; i < l; i++) {
    dataFloat32[i] = dataInt16[i] / 32768.0;
  }
  if (numChannels === 1) { 
    buffer.copyToChannel(dataFloat32, 0);
  } else if (numChannels > 1) { 
    for (let i = 0; i < numChannels; i++) {
      if (i < buffer.numberOfChannels) { 
        const channelData = new Float32Array(dataFloat32.length / numChannels);
        for (let j = 0, k = 0; j < dataFloat32.length / numChannels; j++) {
          channelData[k++] = dataFloat32[j * numChannels + i];
        }
        buffer.copyToChannel(channelData, i);
      }
    }
  } else {
    console.warn(`decodeAudioData called with unsupported numChannels: ${numChannels}`);
  }
  return buffer;
}

export {createBlob, decode, decodeAudioData, encode};