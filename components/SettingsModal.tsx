'use client';

/**
 * SettingsModal — Chitti's BYO-key configuration surface.
 *
 * Two panels:
 *   • Brain — pick LLM provider (Claude / Kimi / OpenAI-compat / Ollama),
 *     paste API key, optionally override base URL + model.
 *   • Voice — pick TTS provider (Browser native / ElevenLabs),
 *     paste 11Labs key, pick voice id, tune rate/pitch/volume.
 *
 * Everything is stored in localStorage via lib/settings — never sent to
 * Chitti's backend except as a per-request envelope.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { Eye, EyeOff, X, Volume2, Cpu, Save, Trash2, Check } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { cn } from '@/lib/utils';
import {
  DEFAULT_SETTINGS,
  clearSettings,
  loadSettings,
  saveSettings,
} from '@/lib/settings';
import type { ChittiSettings, LlmProviderId, TtsProviderId } from '@/types';

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

interface ProviderPreset {
  id: LlmProviderId;
  label: string;
  baseUrl?: string;
  model?: string;
  hint: string;
}

const LLM_PRESETS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'moonshotai/kimi-k2',
    hint: 'Recommended. One key gets you Kimi K2, Claude, GPT-4, Llama, and ~200 other models. Sign up at openrouter.ai — no client restrictions.',
  },
  {
    id: 'anthropic',
    label: 'Claude',
    model: 'claude-sonnet-4-6',
    hint: 'Anthropic. Key starts with sk-ant-...',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hint: 'OpenAI direct.',
  },
  {
    id: 'openai',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    hint: 'Fast OSS inference. Free tier available.',
  },
  {
    id: 'openai',
    label: 'Moonshot',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2.6',
    hint: 'Moonshot Platform direct (platform.moonshot.ai — separate from platform.kimi.ai). For plain sk- keys without the kimi- prefix.',
  },
  {
    id: 'openai',
    label: 'Kimi',
    baseUrl: 'https://api.kimi.com/coding/v1',
    model: 'kimi-k2.6',
    hint: '⚠ Kimi Code keys (sk-kimi-…) are restricted to Moonshot’s allowlisted CLIs and won’t work in custom apps. For Kimi K2 from Chitti, use OPENROUTER instead.',
  },
  {
    id: 'auto',
    label: 'Auto',
    hint: 'Use whatever provider is configured via server env vars on Vercel.',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'llama3.1:8b',
    hint: 'Local OSS. Only works if Ollama is reachable from where Chitti runs (not from Vercel).',
  },
];

// Known model variants per provider — clicking a chip fills the MODEL input.
// The text field stays editable, so users can still type any unlisted id.
//
// Lineup current as of May 2026. Kimi-K2 preview series and kimi-latest are
// being deprecated; kimi-k2.6 is the flagship, kimi-k2.5 still active.
interface ModelChip {
  id: string;
  note: string;
}

const KIMI_MODEL_CHIPS: ModelChip[] = [
  { id: 'kimi-k2.6', note: 'Flagship, Apr 2026' },
  { id: 'kimi-k2.5', note: 'Jan 2026 release' },
  { id: 'kimi-k2-turbo-preview', note: 'Faster, lower cost' },
  { id: 'kimi-k2-thinking', note: 'Reasoning variant' },
];

const MOONSHOT_LEGACY_CHIPS: ModelChip[] = [
  { id: 'moonshot-v1-8k', note: 'Long context — 8k' },
  { id: 'moonshot-v1-32k', note: 'Long context — 32k' },
  { id: 'moonshot-v1-128k', note: 'Long context — 128k' },
  { id: 'moonshot-v1-auto', note: 'Auto context size' },
];

const OPENAI_MODEL_CHIPS: ModelChip[] = [
  { id: 'gpt-4o-mini', note: 'Fast + cheap' },
  { id: 'gpt-4o', note: 'Standard' },
  { id: 'o3-mini', note: 'Reasoning' },
];

const OPENROUTER_MODEL_CHIPS: ModelChip[] = [
  { id: 'moonshotai/kimi-k2', note: 'Kimi K2 — main' },
  { id: 'moonshotai/kimi-k2-0905', note: 'Kimi K2 0905 release' },
  { id: 'moonshotai/kimi-k2:free', note: 'Kimi K2 — free tier' },
  { id: 'anthropic/claude-sonnet-4.5', note: 'Sonnet 4.5' },
  { id: 'openai/gpt-4o-mini', note: 'GPT-4o-mini — fast' },
  { id: 'meta-llama/llama-3.3-70b-instruct', note: 'Llama 3.3 70B' },
  { id: 'deepseek/deepseek-chat', note: 'DeepSeek V3' },
];

const GROQ_MODEL_CHIPS: ModelChip[] = [
  { id: 'llama-3.3-70b-versatile', note: 'Llama 3.3 70B' },
  { id: 'mixtral-8x7b-32768', note: 'Mixtral 8x7B' },
];

const DEEPSEEK_MODEL_CHIPS: ModelChip[] = [
  { id: 'deepseek-chat', note: 'V3 chat' },
  { id: 'deepseek-reasoner', note: 'R1 reasoning' },
];

const CLAUDE_MODEL_CHIPS: ModelChip[] = [
  { id: 'claude-sonnet-4-6', note: 'Sonnet 4.6 — balanced' },
  { id: 'claude-opus-4-7', note: 'Opus 4.7 — most capable' },
  { id: 'claude-haiku-4-5', note: 'Haiku 4.5 — fastest' },
];

// Curated ElevenLabs voices that suit a Jarvis-style assistant.
const TTS_VOICE_OPTIONS: Array<{ id: string; label: string; note: string }> = [
  { id: 'onwK4e9ZLuTAKqWW03F9', label: 'Daniel', note: 'British male — Jarvis-leaning' },
  { id: 'TX3LPaxmHKxFdv7VOQHJ', label: 'Liam', note: 'Young British male' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', label: 'George', note: 'Mature British male' },
  { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Bella', note: 'Calm female' },
  { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel', note: 'Neutral female' },
];

interface SecretInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}

function SecretInput({ value, onChange, placeholder, ariaLabel }: SecretInputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        spellCheck={false}
        className="w-full bg-chitti-900/60 border border-chitti-700/60 focus:border-chitti-400/80 rounded px-3 py-2 pr-10 font-mono text-xs text-chitti-50 placeholder:text-chitti-500/50 outline-none transition-colors"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        title={visible ? 'Hide' : 'Show'}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-chitti-400/80 hover:text-chitti-200 transition-colors"
      >
        {visible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

interface TextInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}

function TextInput({ value, onChange, placeholder, ariaLabel }: TextInputProps) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      autoComplete="off"
      spellCheck={false}
      className="w-full bg-chitti-900/60 border border-chitti-700/60 focus:border-chitti-400/80 rounded px-3 py-2 font-mono text-xs text-chitti-50 placeholder:text-chitti-500/50 outline-none transition-colors"
    />
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block font-mono text-[10px] tracking-[0.3em] text-chitti-300/80 uppercase mb-1.5">
      {children}
    </label>
  );
}

export default function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [tab, setTab] = useState<'brain' | 'voice'>('brain');
  const [settings, setSettings] = useState<ChittiSettings>(DEFAULT_SETTINGS);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Reload from storage every time the modal opens so we never show stale state.
  useEffect(() => {
    if (open) {
      setSettings(loadSettings());
      setSavedAt(null);
      setTab('brain');
    }
  }, [open]);

  const activePresetLabel = useMemo(() => {
    const { provider, baseUrl } = settings.llm;
    if (provider === 'auto') return 'Auto';
    if (provider === 'anthropic') return 'Claude';
    if (provider === 'ollama') return 'Ollama';
    if (provider === 'openai') {
      const lower = (baseUrl ?? '').toLowerCase();
      // IMPORTANT: check kimi.com BEFORE moonshot — the Kimi Code endpoint
      // is api.kimi.com/coding/v1, the legacy Moonshot one is api.moonshot.ai.
      if (lower.includes('kimi.com')) return 'Kimi';
      if (lower.includes('moonshot')) return 'Moonshot';
      if (lower.includes('openrouter')) return 'OpenRouter';
      if (lower.includes('groq')) return 'Groq';
      if (lower.includes('deepseek')) return 'DeepSeek';
      return 'OpenAI';
    }
    return 'Auto';
  }, [settings.llm]);

  // Auto-correct mismatched endpoint when an sk-kimi- key is pasted into the
  // wrong preset. Those keys only authenticate against api.kimi.com/coding/v1,
  // so silently fix base URL + model the moment we see the prefix — saves the
  // user a "why does it 401" round-trip.
  useEffect(() => {
    const key = settings.llm.apiKey ?? '';
    if (!key.startsWith('sk-kimi-')) return;
    const lower = (settings.llm.baseUrl ?? '').toLowerCase();
    if (lower.includes('kimi.com')) return; // already correct
    setSettings((prev) => ({
      ...prev,
      llm: {
        ...prev.llm,
        provider: 'openai',
        baseUrl: 'https://api.kimi.com/coding/v1',
        model: 'kimi-latest',
      },
    }));
  }, [settings.llm.apiKey, settings.llm.baseUrl]);

  const applyPreset = useCallback((preset: ProviderPreset) => {
    setSettings((prev) => ({
      ...prev,
      llm: {
        ...prev.llm,
        provider: preset.id,
        baseUrl: preset.baseUrl,
        model: preset.model,
      },
    }));
  }, []);

  const onSave = useCallback(() => {
    saveSettings(settings);
    setSavedAt(Date.now());
    // brief "Saved" pulse, then auto-close
    setTimeout(() => onClose(), 700);
  }, [settings, onClose]);

  const onReset = useCallback(() => {
    clearSettings();
    setSettings(DEFAULT_SETTINGS);
    setSavedAt(Date.now());
  }, []);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          aria-modal
          role="dialog"
          aria-label="Chitti settings"
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-[#02060c]/80 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden
          />

          {/* Modal */}
          <motion.div
            className="relative glass-strong hud-corners w-full max-w-2xl max-h-[90vh] flex flex-col rounded-md border border-chitti-500/30"
            initial={{ y: 16, scale: 0.98, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 8, scale: 0.99, opacity: 0 }}
            transition={{ duration: 0.18 }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-chitti-700/40">
              <div className="flex items-center gap-3">
                <span className="font-display tracking-[0.3em] text-chitti-100 text-sm text-glow">
                  SETTINGS
                </span>
                <span className="font-mono text-[10px] tracking-[0.25em] text-chitti-400/70">
                  CHITTI / BYO-KEY
                </span>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close settings"
                className="text-chitti-300/80 hover:text-chitti-100 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex gap-1 px-4 pt-3">
              {(['brain', 'voice'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cn(
                    'flex items-center gap-2 px-3 py-1.5 rounded-t text-xs font-display tracking-[0.25em] transition-colors',
                    tab === t
                      ? 'bg-chitti-800/50 text-chitti-100 border-t border-l border-r border-chitti-500/40'
                      : 'text-chitti-400/70 hover:text-chitti-200',
                  )}
                >
                  {t === 'brain' ? (
                    <Cpu className="w-3.5 h-3.5" />
                  ) : (
                    <Volume2 className="w-3.5 h-3.5" />
                  )}
                  {t === 'brain' ? 'BRAIN' : 'VOICE'}
                </button>
              ))}
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
              {tab === 'brain' && (
                <BrainTab
                  settings={settings}
                  setSettings={setSettings}
                  applyPreset={applyPreset}
                  activePresetLabel={activePresetLabel}
                />
              )}
              {tab === 'voice' && (
                <VoiceTab settings={settings} setSettings={setSettings} />
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-chitti-700/40">
              <button
                type="button"
                onClick={onReset}
                className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono tracking-[0.2em] text-chitti-400/70 hover:text-signal-red transition-colors"
                title="Wipe local settings"
              >
                <Trash2 className="w-3.5 h-3.5" />
                RESET
              </button>
              <div className="flex items-center gap-3">
                {savedAt && (
                  <span className="flex items-center gap-1 font-mono text-[10px] tracking-[0.2em] text-signal-green">
                    <Check className="w-3.5 h-3.5" />
                    SAVED
                  </span>
                )}
                <button
                  type="button"
                  onClick={onSave}
                  className="flex items-center gap-2 px-4 py-2 rounded border border-chitti-400/70 bg-chitti-500/15 text-chitti-100 hover:bg-chitti-500/30 transition-colors font-display tracking-[0.2em] text-xs"
                  style={{ boxShadow: '0 0 18px rgba(0, 184, 230, 0.35)' }}
                >
                  <Save className="w-4 h-4" />
                  SAVE
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ─────────────────────────  Brain tab  ───────────────────────── */

interface BrainTabProps {
  settings: ChittiSettings;
  setSettings: React.Dispatch<React.SetStateAction<ChittiSettings>>;
  applyPreset: (preset: ProviderPreset) => void;
  activePresetLabel: string;
}

function BrainTab({
  settings,
  setSettings,
  applyPreset,
  activePresetLabel,
}: BrainTabProps) {
  const updateLlm = (patch: Partial<ChittiSettings['llm']>) => {
    setSettings((prev) => ({ ...prev, llm: { ...prev.llm, ...patch } }));
  };

  // Pick the right chip list based on the active preset + base URL.
  const modelChips: ModelChip[] = (() => {
    if (activePresetLabel === 'Claude') return CLAUDE_MODEL_CHIPS;
    if (activePresetLabel === 'Kimi') return KIMI_MODEL_CHIPS;
    if (activePresetLabel === 'Moonshot')
      return [...KIMI_MODEL_CHIPS, ...MOONSHOT_LEGACY_CHIPS];
    if (activePresetLabel === 'OpenRouter') return OPENROUTER_MODEL_CHIPS;
    if (activePresetLabel === 'Groq') return GROQ_MODEL_CHIPS;
    if (activePresetLabel === 'DeepSeek') return DEEPSEEK_MODEL_CHIPS;
    if (activePresetLabel === 'OpenAI') return OPENAI_MODEL_CHIPS;
    return [];
  })();

  return (
    <div className="space-y-5">
      <div>
        <FieldLabel>PROVIDER</FieldLabel>
        <div className="flex flex-wrap gap-2">
          {LLM_PRESETS.map((p) => {
            const active = p.label === activePresetLabel;
            return (
              <button
                key={p.label}
                type="button"
                onClick={() => applyPreset(p)}
                className={cn(
                  'px-3 py-1.5 rounded border text-xs font-display tracking-[0.2em] transition-colors',
                  active
                    ? 'border-chitti-400/80 bg-chitti-500/20 text-chitti-100'
                    : 'border-chitti-700/60 text-chitti-300 hover:border-chitti-500/60 hover:text-chitti-100',
                )}
              >
                {p.label.toUpperCase()}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-chitti-400/70 leading-snug">
          {LLM_PRESETS.find((p) => p.label === activePresetLabel)?.hint ??
            'Auto-resolves on the server.'}
        </p>
      </div>

      {settings.llm.provider !== 'auto' && settings.llm.provider !== 'ollama' && (
        <div>
          <FieldLabel>API KEY</FieldLabel>
          <SecretInput
            value={settings.llm.apiKey ?? ''}
            onChange={(v) => updateLlm({ apiKey: v })}
            placeholder={
              settings.llm.provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'
            }
            ariaLabel="LLM API key"
          />
          <p className="mt-1.5 text-[10px] text-chitti-500/70">
            Stored in your browser only. Sent with each chat request — never logged on the server.
          </p>
        </div>
      )}

      {settings.llm.provider === 'openai' && (
        <div>
          <FieldLabel>BASE URL</FieldLabel>
          <TextInput
            value={settings.llm.baseUrl ?? ''}
            onChange={(v) => updateLlm({ baseUrl: v })}
            placeholder="https://api.moonshot.ai/v1"
            ariaLabel="Base URL"
          />
        </div>
      )}

      {settings.llm.provider !== 'auto' && (
        <div>
          <FieldLabel>MODEL</FieldLabel>
          <TextInput
            value={settings.llm.model ?? ''}
            onChange={(v) => updateLlm({ model: v })}
            placeholder={
              settings.llm.provider === 'anthropic'
                ? 'claude-sonnet-4-6'
                : settings.llm.provider === 'ollama'
                  ? 'llama3.1:8b'
                  : 'kimi-k2.6'
            }
            ariaLabel="Model id"
          />

          {modelChips.length > 0 && (
            <div className="mt-2">
              <div className="font-mono text-[9px] tracking-[0.3em] text-chitti-400/60 mb-1.5">
                VARIANTS
              </div>
              <div className="flex flex-wrap gap-1.5">
                {modelChips.map((chip) => {
                  const active = settings.llm.model === chip.id;
                  return (
                    <button
                      key={chip.id}
                      type="button"
                      onClick={() => updateLlm({ model: chip.id })}
                      title={chip.note}
                      className={cn(
                        'px-2 py-1 rounded border text-[10px] font-mono transition-colors',
                        active
                          ? 'border-chitti-400/80 bg-chitti-500/20 text-chitti-100'
                          : 'border-chitti-700/60 text-chitti-300/90 hover:border-chitti-500/60 hover:text-chitti-100',
                      )}
                    >
                      {chip.id}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[10px] text-chitti-500/60 leading-snug">
                Click a chip to fill the field. You can still type any custom model id.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────  Voice tab  ───────────────────────── */

interface VoiceTabProps {
  settings: ChittiSettings;
  setSettings: React.Dispatch<React.SetStateAction<ChittiSettings>>;
}

function VoiceTab({ settings, setSettings }: VoiceTabProps) {
  const updateTts = (patch: Partial<ChittiSettings['tts']>) => {
    setSettings((prev) => ({ ...prev, tts: { ...prev.tts, ...patch } }));
  };
  const updateVoice = (patch: Partial<ChittiSettings['voice']>) => {
    setSettings((prev) => ({ ...prev, voice: { ...prev.voice, ...patch } }));
  };

  return (
    <div className="space-y-5">
      <div>
        <FieldLabel>TTS ENGINE</FieldLabel>
        <div className="flex gap-2">
          {(['browser', 'elevenlabs'] as TtsProviderId[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => updateTts({ provider: p })}
              className={cn(
                'flex-1 px-3 py-2 rounded border text-xs font-display tracking-[0.2em] transition-colors',
                settings.tts.provider === p
                  ? 'border-chitti-400/80 bg-chitti-500/20 text-chitti-100'
                  : 'border-chitti-700/60 text-chitti-300 hover:border-chitti-500/60',
              )}
            >
              {p === 'browser' ? 'BROWSER (FREE)' : 'ELEVENLABS (PREMIUM)'}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-chitti-400/70 leading-snug">
          {settings.tts.provider === 'browser'
            ? 'Web Speech API. Chitti picks the best Jarvis-leaning voice your device has (Daniel / UK Male).'
            : 'Streams natural audio from ElevenLabs. Requires an API key from elevenlabs.io.'}
        </p>
      </div>

      {settings.tts.provider === 'elevenlabs' && (
        <>
          <div>
            <FieldLabel>ELEVENLABS API KEY</FieldLabel>
            <SecretInput
              value={settings.tts.apiKey ?? ''}
              onChange={(v) => updateTts({ apiKey: v })}
              placeholder="sk_…"
              ariaLabel="ElevenLabs API key"
            />
          </div>

          <div>
            <FieldLabel>VOICE</FieldLabel>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {TTS_VOICE_OPTIONS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => updateTts({ voiceId: v.id })}
                  className={cn(
                    'text-left px-3 py-2 rounded border transition-colors',
                    settings.tts.voiceId === v.id
                      ? 'border-chitti-400/80 bg-chitti-500/20'
                      : 'border-chitti-700/60 hover:border-chitti-500/60',
                  )}
                >
                  <div className="font-display tracking-[0.18em] text-[11px] text-chitti-100">
                    {v.label.toUpperCase()}
                  </div>
                  <div className="font-mono text-[10px] text-chitti-400/70 mt-0.5">
                    {v.note}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <FieldLabel>MODEL</FieldLabel>
            <TextInput
              value={settings.tts.modelId ?? ''}
              onChange={(v) => updateTts({ modelId: v })}
              placeholder="eleven_turbo_v2_5"
              ariaLabel="ElevenLabs model"
            />
            <p className="mt-1 text-[10px] text-chitti-500/70">
              eleven_turbo_v2_5 = fastest. eleven_multilingual_v2 = highest quality.
            </p>
          </div>
        </>
      )}

      {settings.tts.provider === 'browser' && (
        <div className="space-y-4">
          <SliderRow
            label="RATE"
            min={0.5}
            max={1.5}
            step={0.05}
            value={settings.voice.rate}
            onChange={(v) => updateVoice({ rate: v })}
          />
          <SliderRow
            label="PITCH"
            min={0.5}
            max={1.5}
            step={0.05}
            value={settings.voice.pitch}
            onChange={(v) => updateVoice({ pitch: v })}
          />
          <SliderRow
            label="VOLUME"
            min={0}
            max={1}
            step={0.05}
            value={settings.voice.volume}
            onChange={(v) => updateVoice({ volume: v })}
          />
        </div>
      )}
    </div>
  );
}

function SliderRow({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-mono text-[10px] tracking-[0.3em] text-chitti-300/80 uppercase">
          {label}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-chitti-100">
          {value.toFixed(2)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-chitti-400"
      />
    </div>
  );
}
