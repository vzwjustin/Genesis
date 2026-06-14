"use client";

import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Card, Button, Input, Toggle } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { FusionPlugin$outboundSchema } from "@openrouter/sdk/models";

// Presets mirror the OpenRouter /labs/fusion UI. Empty analysis_models => Quality default.
const PRESETS = {
  quality: {
    label: "Quality",
    models: [
      "anthropic/claude-opus-latest",
      "openai/gpt-latest",
      "google/gemini-pro-latest",
    ],
  },
  budget: {
    label: "Budget",
    models: [
      "google/gemini-flash-latest",
      "deepseek/deepseek-v3.2",
      "moonshotai/kimi-latest",
    ],
  },
};

const emptyConfig = () => ({
  enabled: true,
  analysis_models: [],
  model: "",
  max_tool_calls: "",
});

function normalizeFromStored(stored) {
  if (!stored || typeof stored !== "object") return emptyConfig();
  return {
    enabled: stored.enabled !== false,
    analysis_models: Array.isArray(stored.analysis_models) ? stored.analysis_models : [],
    model: typeof stored.model === "string" ? stored.model : "",
    max_tool_calls: Number.isFinite(stored.max_tool_calls) ? String(stored.max_tool_calls) : "",
  };
}

// Build the persisted shape and validate it against the OpenRouter SDK schema.
// Returns { ok, value } or { ok: false, error }.
function buildAndValidate(config) {
  const plugin = { id: "fusion", enabled: config.enabled };

  const models = config.analysis_models.map((m) => m.trim()).filter(Boolean);
  if (models.length > 8) {
    return { ok: false, error: "Analysis panel is capped at 8 models." };
  }
  if (models.length > 0) plugin.analysisModels = models;

  const judge = config.model.trim();
  if (judge) plugin.model = judge;

  if (config.max_tool_calls !== "") {
    const n = Number(config.max_tool_calls);
    if (!Number.isInteger(n) || n < 1 || n > 16) {
      return { ok: false, error: "Max tool calls must be an integer between 1 and 16." };
    }
    plugin.maxToolCalls = n;
  }

  // SDK schema validates + maps camelCase -> snake_case outbound shape.
  const parsed = FusionPlugin$outboundSchema.safeParse(plugin);
  if (!parsed.success) {
    return { ok: false, error: parsed.error?.issues?.[0]?.message || "Invalid Fusion configuration." };
  }
  // Drop id/enabled-default noise we don't need to persist beyond what the proxy reads.
  const { id: _id, ...rest } = parsed.data;
  return { ok: true, value: { enabled: config.enabled, ...rest } };
}

export default function FusionConfigSection({ connections, onSaved }) {
  const notify = useNotificationStore();

  // Config is per-connection. Default to the first connection (the common single-key case).
  const [selectedId, setSelectedId] = useState(connections[0]?.id || null);
  const selected = useMemo(
    () => connections.find((c) => c.id === selectedId) || connections[0] || null,
    [connections, selectedId]
  );

  const [config, setConfig] = useState(emptyConfig);
  const [modelsText, setModelsText] = useState("");
  const [saving, setSaving] = useState(false);

  // Reload the form from storage whenever the selected connection changes — the
  // React-recommended "adjust state during render" pattern (no effect needed).
  const [syncedId, setSyncedId] = useState(null);
  if (selected && selected.id !== syncedId) {
    const next = normalizeFromStored(selected.providerSpecificData?.fusion);
    setConfig(next);
    setModelsText(next.analysis_models.join("\n"));
    setSyncedId(selected.id);
  }

  if (!selected) {
    return (
      <Card>
        <h2 className="mb-2 text-lg font-semibold">Fusion Configuration</h2>
        <p className="text-sm text-text-muted">
          Add a connection with your OpenRouter API key to configure the Fusion panel and judge.
        </p>
      </Card>
    );
  }

  const applyPreset = (key) => {
    const models = PRESETS[key]?.models || [];
    setModelsText(models.join("\n"));
    setConfig((c) => ({ ...c, analysis_models: models }));
  };

  const handleSave = async () => {
    const merged = {
      ...config,
      analysis_models: modelsText
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    };
    const result = buildAndValidate(merged);
    if (!result.ok) {
      notify.error(result.error);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/providers/${selected.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerSpecificData: { fusion: result.value } }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Save failed (${res.status})`);
      }
      notify.success("Fusion configuration saved.");
      onSaved?.();
    } catch (error) {
      notify.error(error?.message || "Failed to save Fusion configuration.");
    } finally {
      setSaving(false);
    }
  };

  const modelCount = modelsText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).length;

  return (
    <Card>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Fusion Configuration</h2>
          <p className="mt-0.5 text-xs text-text-muted">
            Customize the expert panel and judge. Applied to requests unless the client sends its own{" "}
            <code className="font-mono">plugins</code> field.
          </p>
        </div>
        {connections.length > 1 && (
          <select
            value={selected.id}
            onChange={(e) => setSelectedId(e.target.value)}
            className="rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm"
          >
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || c.id}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <Toggle
          checked={config.enabled}
          onChange={(v) => setConfig((c) => ({ ...c, enabled: v }))}
          label="Enable Fusion deliberation"
          description="When off, requests pass through to the judge model alone without the panel."
        />

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-main">
            Analysis panel models{" "}
            <span className="font-normal text-text-muted">({modelCount}/8 · one slug per line)</span>
          </label>
          <textarea
            value={modelsText}
            onChange={(e) => setModelsText(e.target.value)}
            rows={4}
            placeholder={"anthropic/claude-opus-latest\nopenai/gpt-latest\ngoogle/gemini-pro-latest"}
            className="rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-xs leading-relaxed"
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-text-muted">Presets:</span>
            {Object.entries(PRESETS).map(([key, p]) => (
              <Button key={key} size="sm" variant="secondary" onClick={() => applyPreset(key)}>
                {p.label}
              </Button>
            ))}
            <span className="text-xs text-text-muted">Leave empty for the Quality default.</span>
          </div>
        </div>

        <Input
          label="Judge model (optional)"
          placeholder="defaults to first panel model"
          value={config.model}
          onChange={(e) => setConfig((c) => ({ ...c, model: e.target.value }))}
          hint="Slug of the model that synthesizes the final answer."
        />

        <Input
          label="Max tool calls (optional)"
          type="number"
          placeholder="8"
          value={config.max_tool_calls}
          onChange={(e) => setConfig((c) => ({ ...c, max_tool_calls: e.target.value }))}
          hint="Web-research steps per panelist/judge. 1–16, default 8."
        />

        <div className="flex justify-end">
          <Button icon="save" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save Configuration"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

FusionConfigSection.propTypes = {
  connections: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string,
      providerSpecificData: PropTypes.object,
    })
  ).isRequired,
  onSaved: PropTypes.func,
};
