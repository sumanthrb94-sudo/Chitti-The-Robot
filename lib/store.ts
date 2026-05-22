/**
 * Zustand store for Chitti.
 * Owns conversation state, voice settings, runtime state, and streaming flag.
 *
 * Kept deliberately small and synchronous — all async work (network, speech)
 * happens in components or lib modules that call these actions.
 */

import { create } from 'zustand';
import type { ChatMessage, ChittiState, VoiceSettings } from '@/types';

export interface ChittiStore {
  /* state */
  messages: ChatMessage[];
  state: ChittiState;
  voiceEnabled: boolean;
  voiceSettings: VoiceSettings;
  inputText: string;
  isStreaming: boolean;

  /* actions */
  addMessage: (msg: ChatMessage) => void;
  updateLastAssistantMessage: (updater: (m: ChatMessage) => ChatMessage) => void;
  setState: (s: ChittiState) => void;
  setVoiceEnabled: (v: boolean) => void;
  setVoiceSettings: (patch: Partial<VoiceSettings>) => void;
  setInputText: (t: string) => void;
  setIsStreaming: (b: boolean) => void;
  resetConversation: () => void;
}

const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: true,
  autoListen: false,
  rate: 1.05,
  pitch: 1.0,
  volume: 1.0,
};

export const useChittiStore = create<ChittiStore>((set) => ({
  messages: [],
  state: 'idle',
  voiceEnabled: true,
  voiceSettings: { ...DEFAULT_VOICE_SETTINGS },
  inputText: '',
  isStreaming: false,

  addMessage: (msg) =>
    set((s) => ({ messages: [...s.messages, msg] })),

  updateLastAssistantMessage: (updater) =>
    set((s) => {
      // Find the index of the most recent assistant message (scan backwards).
      let lastIdx = -1;
      for (let i = s.messages.length - 1; i >= 0; i--) {
        if (s.messages[i].role === 'assistant') {
          lastIdx = i;
          break;
        }
      }
      if (lastIdx === -1) return s;
      const next = s.messages.slice();
      next[lastIdx] = updater(next[lastIdx]);
      return { messages: next };
    }),

  setState: (state) => set({ state }),

  setVoiceEnabled: (voiceEnabled) =>
    set((s) => ({
      voiceEnabled,
      voiceSettings: { ...s.voiceSettings, enabled: voiceEnabled },
    })),

  setVoiceSettings: (patch) =>
    set((s) => ({ voiceSettings: { ...s.voiceSettings, ...patch } })),

  setInputText: (inputText) => set({ inputText }),

  setIsStreaming: (isStreaming) => set({ isStreaming }),

  resetConversation: () =>
    set({
      messages: [],
      state: 'idle',
      isStreaming: false,
      inputText: '',
    }),
}));
