"use client";

import { useState } from "react";
import { Card, ModelSelectModal } from "@/shared/components";
import InlineAlert from "@/shared/components/InlineAlert";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import Image from "next/image";
import ApiKeySelect from "./ApiKeySelect";

export default function DefaultToolCard({ toolId, tool, isExpanded, onToggle, baseUrl, apiKeys, activeProviders = [], cloudEnabled = false, tunnelEnabled = false }) {
  const [copiedField, setCopiedField] = useState(null);
  const [showModelModal, setShowModelModal] = useState(false);
  const [modelValue, setModelValue] = useState("");
  
  // Initialize state directly with computed value - no need for useEffect
  const [selectedApiKey, setSelectedApiKey] = useState(() => 
    ""
  );

  const replaceVars = (text) => {
    const keyToUse = (selectedApiKey && selectedApiKey.trim()) 
      ? selectedApiKey 
      : (!cloudEnabled ? "sk_genesis" : "your-api-key");
    
    // Add /v1 suffix only if not already present (DRY - avoid duplicate)
    const normalizedBaseUrl = baseUrl || "http://localhost:20128";
    const baseUrlWithV1 = normalizedBaseUrl.endsWith("/v1") 
      ? normalizedBaseUrl 
      : `${normalizedBaseUrl}/v1`;
    
    return text
      .replace(/\{\{baseUrl\}\}/g, baseUrlWithV1)
      .replace(/\{\{apiKey\}\}/g, keyToUse)
      .replace(/\{\{model\}\}/g, modelValue || "provider/model-id");
  };

  const { copy: copyToClipboard } = useCopyToClipboard();

  const handleCopy = async (text, field) => {
    await copyToClipboard(replaceVars(text), `toolcard-${field}`);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleSelectModel = (model) => {
    setModelValue(model.value);
  };

  const hasActiveProviders = activeProviders.length > 0;

  const renderApiKeySelector = () => (
    <div className="mt-2 flex flex-col sm:flex-row sm:items-center gap-2">
      <ApiKeySelect value={selectedApiKey} onChange={setSelectedApiKey} apiKeys={apiKeys} cloudEnabled={cloudEnabled} className="flex-1" />
    </div>
  );

  const renderModelSelector = () => {
    return (
      <div className="mt-2 flex flex-col sm:flex-row sm:items-center gap-2">
        <input
          type="text"
          value={modelValue}
          onChange={(e) => setModelValue(e.target.value)}
          placeholder="provider/model-id"
          className="w-full sm:w-auto flex-1 px-3 py-2 glass-input rounded-lg text-sm"
        />
        <button
          onClick={() => setShowModelModal(true)}
          disabled={!hasActiveProviders}
          className={`shrink-0 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
            hasActiveProviders
              ? "dashboard-chip-active cursor-pointer"
              : "opacity-50 cursor-not-allowed glass-control border-0"
          }`}
        >
          Select Model
        </button>
        {modelValue && (
          <>
            <button
              onClick={() => handleCopy(modelValue, "model")}
              className="dashboard-row-hover glass-stat shrink-0 border-0 px-3 py-2 rounded-lg transition-colors"
            >
              <span className="material-symbols-outlined text-lg">
                {copiedField === "model" ? "check" : "content_copy"}
              </span>
            </button>
            <button
              onClick={() => setModelValue("")}
              className="p-2 text-text-muted hover:text-danger rounded transition-colors"
              title="Clear"
            >
              <span className="material-symbols-outlined text-lg">close</span>
            </button>
          </>
        )}
        {tool.defaultModels?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 sm:col-span-full">
            {tool.defaultModels.map((model) => (
              <button
                key={model.id}
                type="button"
                onClick={() => setModelValue(model.defaultValue || model.id)}
                className="dashboard-chip-active px-2 py-1 rounded text-xs font-medium transition-colors"
              >
                {model.name}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderNotes = () => {
    if (!tool.notes || tool.notes.length === 0) return null;

    return (
      <div className="flex flex-col gap-2 mb-4">
        {tool.notes.map((note, index) => {
          if (note.type === "cloudCheck" && (cloudEnabled || tunnelEnabled)) return null;

          const isWarning = note.type === "warning";
          const isError = note.type === "cloudCheck" && !cloudEnabled && !tunnelEnabled;
          const variant = isError ? "danger" : isWarning ? "caution" : "info";

          return <InlineAlert key={index} variant={variant} message={note.text} />;
        })}
      </div>
    );
  };

  const canShowGuide = () => {
    if (tool.requiresExternalUrl && !cloudEnabled && !tunnelEnabled) return false;
    if (tool.requiresCloud && !cloudEnabled) return false;
    return true;
  };

  const renderGuideSteps = () => {
    if (!tool.guideSteps) return <p className="text-text-muted text-sm">Coming soon...</p>;

    return (
      <div className="flex flex-col gap-4">
        {renderNotes()}
        {canShowGuide() && tool.guideSteps.map((item) => (
          <div key={item.step} className="flex items-start gap-4">
            <div 
              className="size-8 rounded-full flex items-center justify-center shrink-0 text-sm font-semibold text-white"
              style={{ backgroundColor: tool.color }}
            >
              {item.step}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-text">{item.title}</p>
              {item.desc && <p className="text-sm text-text-muted mt-0.5">{item.desc}</p>}
              {item.type === "apiKeySelector" && renderApiKeySelector()}
              {item.type === "modelSelector" && renderModelSelector()}
              {item.value && (
                <div className="mt-2 flex flex-col sm:flex-row sm:items-center gap-2">
                  <code className="glass-stat border-0 w-full sm:w-auto flex-1 truncate px-3 py-2 text-sm font-mono">
                    {replaceVars(item.value)}
                  </code>
                  {item.copyable && (
                    <button
                      onClick={() => handleCopy(item.value, `${item.step}-${item.title}`)}
                      className="dashboard-row-hover glass-stat shrink-0 border-0 px-3 py-2 rounded-lg transition-colors"
                    >
                      <span className="material-symbols-outlined text-lg">
                        {copiedField === `${item.step}-${item.title}` ? "check" : "content_copy"}
                      </span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}

        {canShowGuide() && tool.codeBlock && (
          <div className="mt-2">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-text-muted uppercase tracking-wide">{tool.codeBlock.language}</span>
              <button
                onClick={() => handleCopy(tool.codeBlock.code, "codeblock")}
                className="dashboard-chip-active flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors"
              >
                <span className="material-symbols-outlined text-sm">
                  {copiedField === "codeblock" ? "check" : "content_copy"}
                </span>
                {copiedField === "codeblock" ? "Copied!" : "Copy"}
              </button>
            </div>
            <pre className="glass-stat overflow-x-auto border-0 p-4">
              <code className="text-sm font-mono whitespace-pre">{replaceVars(tool.codeBlock.code)}</code>
            </pre>
          </div>
        )}
      </div>
    );
  };

  const renderIcon = () => {
    if (tool.image) {
      return (
        <Image
          src={tool.image}
          alt={tool.name}
          width={32}
          height={32}
          className="size-8 object-contain rounded-lg"
          sizes="32px"
          onError={(e) => { e.target.style.display = "none"; }}
        />
      );
    }
    if (tool.icon) {
      return <span className="material-symbols-outlined text-xl" style={{ color: tool.color }}>{tool.icon}</span>;
    }
    return (
      <Image
        src={`/providers/${toolId}.png`}
        alt={tool.name}
        width={32}
        height={32}
        className="size-8 object-contain rounded-lg"
        sizes="32px"
        onError={(e) => { e.target.style.display = "none"; }}
      />
    );
  };

  return (
    <Card padding="xs" className="overflow-hidden overflow-x-hidden">
      <div className="dashboard-row-hover -mx-3 flex cursor-pointer items-center justify-between rounded-lg px-3 transition-colors" onClick={onToggle}>
        <div className="flex items-center gap-3">
          <div className="size-8 rounded-lg flex items-center justify-center shrink-0">
            {renderIcon()}
          </div>
          <div className="min-w-0">
            <h3 className="font-medium text-sm">{tool.name}</h3>
            <p className="text-xs text-text-muted truncate">{tool.description}</p>
          </div>
        </div>
        <span className={`material-symbols-outlined text-text-muted text-[20px] transition-transform ${isExpanded ? "rotate-180" : ""}`}>expand_more</span>
      </div>

      {isExpanded && (
        <div className="mt-6 pt-6 border-t border-border">
          {renderGuideSteps()}
        </div>
      )}

      <ModelSelectModal
        isOpen={showModelModal}
        onClose={() => setShowModelModal(false)}
        onSelect={handleSelectModel}
        selectedModel={modelValue}
        activeProviders={activeProviders}
        title="Select Model"
      />
    </Card>
  );
}

