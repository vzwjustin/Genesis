"use client";

import { useState, useEffect } from "react";
import { getDefaultPricing } from "@/shared/constants/pricing.js";
import { diffPricingOverrides } from "@/shared/utils/dashboardHelpers";
import { confirmDialog } from "@/store/confirmStore";
import { useNotificationStore } from "@/store/notificationStore";

export default function PricingModal({ isOpen, onClose, onSave }) {
  const notify = useNotificationStore();
  const [pricingData, setPricingData] = useState({});
  const [userOverrides, setUserOverrides] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadPricing = async () => {
    setLoading(true);
    try {
      const [pricingRes, overridesRes] = await Promise.all([
        fetch("/api/pricing"),
        fetch("/api/pricing/user-overrides"),
      ]);
      if (pricingRes.ok) {
        const data = await pricingRes.json();
        setPricingData(data);
      } else {
        setPricingData(getDefaultPricing());
      }
      if (overridesRes.ok) {
        setUserOverrides(await overridesRes.json());
      } else {
        setUserOverrides({});
      }
    } catch (error) {
      console.error("Failed to load pricing:", error);
      setPricingData(getDefaultPricing());
      setUserOverrides({});
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      loadPricing();
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePricingChange = (provider, model, field, value) => {
    const numValue = parseFloat(value);
    if (isNaN(numValue) || numValue < 0) return;

    setPricingData(prev => {
      const newData = { ...prev };
      if (!newData[provider]) newData[provider] = {};
      if (!newData[provider][model]) newData[provider][model] = {};
      newData[provider][model][field] = numValue;
      return newData;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const overrides = diffPricingOverrides(pricingData, getDefaultPricing(), userOverrides);
      const response = await fetch("/api/pricing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(overrides)
      });

      if (response.ok) {
        onSave?.();
        onClose();
      } else {
        const error = await response.json();
        notify.error(error.error || "Failed to save pricing");
      }
    } catch (error) {
      console.error("Failed to save pricing:", error);
      notify.error("Failed to save pricing");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!(await confirmDialog({
      title: "Reset pricing",
      message: "Reset all pricing to defaults? This cannot be undone.",
      confirmText: "Reset",
      danger: true,
    }))) return;

    try {
      const response = await fetch("/api/pricing", { method: "DELETE" });
      if (response.ok) {
        const defaults = getDefaultPricing();
        setPricingData(defaults);
        setUserOverrides({});
        onSave?.();
      } else {
        const error = await response.json().catch(() => ({}));
        notify.error(error.error || "Failed to reset pricing");
      }
    } catch (error) {
      console.error("Failed to reset pricing:", error);
      notify.error("Failed to reset pricing");
    }
  };

  if (!isOpen) return null;

  // Get all unique providers and models for display
  const providerLabel = (provider) => {
    if (provider === "models") return "Canonical models (all providers)";
    return provider.toUpperCase();
  };

  const allProviders = Object.keys(pricingData).sort((a, b) => {
    if (a === "models") return -1;
    if (b === "models") return 1;
    return a.localeCompare(b);
  });
  const pricingFields = ["input", "output", "cached", "reasoning", "cache_creation"];
  const totalModels = allProviders.reduce(
    (sum, provider) => sum + Object.keys(pricingData[provider] || {}).length,
    0,
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 glass-overlay-heavy" onClick={onClose} aria-hidden="true" />
      <div className="relative glass-panel rounded-[14px] shadow-[var(--shadow-elev)] max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h2 className="text-xl font-semibold">Pricing Configuration</h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text text-2xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="text-center py-8 text-text-muted">Loading pricing data...</div>
          ) : (
            <div className="space-y-6">
              {/* Instructions */}
              <div className="glass-stat border-0 rounded-lg p-3 text-sm">
                <p className="font-medium mb-1">Pricing Rates Format</p>
                <p className="text-text-muted">
                  All rates are in <strong>dollars per million tokens</strong> ($/1M tokens).
                  Example: Input rate of 2.50 means $2.50 per 1,000,000 input tokens.
                  {" "}
                  <strong>{totalModels}</strong> model{totalModels === 1 ? "" : "s"} in catalog;
                  provider sections override canonical rates for that provider only.
                </p>
              </div>

              {/* Pricing Tables */}
              {allProviders.map(provider => {
                const models = Object.keys(pricingData[provider]).sort();
                return (
                  <div key={provider} className="glass-panel overflow-hidden rounded-lg border-0">
                    <div className="glass-stat border-0 px-4 py-2 font-semibold text-sm">
                      {providerLabel(provider)}
                      <span className="ml-2 text-text-muted font-normal">
                        ({models.length} model{models.length === 1 ? "" : "s"})
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead className="text-text-muted uppercase text-xs">
                          <tr>
                            <th className="px-3 py-2 text-left">Model</th>
                            <th className="px-3 py-2 text-right">Input</th>
                            <th className="px-3 py-2 text-right">Output</th>
                            <th className="px-3 py-2 text-right">Cached</th>
                            <th className="px-3 py-2 text-right">Reasoning</th>
                            <th className="px-3 py-2 text-right">Cache Creation</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {models.map(model => (
                            <tr key={model} className="dashboard-row-hover transition-colors">
                              <td className="px-3 py-2 font-medium">{model}</td>
                              {pricingFields.map(field => (
                                <td key={field} className="px-3 py-2">
                                  <input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    value={pricingData[provider][model][field] || 0}
                                    onChange={(e) => handlePricingChange(provider, model, field, e.target.value)}
                                    className="glass-input w-20 px-2 py-1 text-right"
                                  />
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}

              {allProviders.length === 0 && (
                <div className="text-center py-8 text-text-muted">
                  No pricing data available
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border flex items-center justify-between gap-2">
          <button
            onClick={handleReset}
            className="px-4 py-2 text-sm text-danger hover:bg-danger/10 rounded border border-danger/20 transition-colors"
            disabled={saving}
          >
            Reset to Defaults
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="glass-btn-soft px-4 py-2 text-sm text-text-muted hover:text-text rounded transition-colors"
              disabled={saving}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm dashboard-chip-active rounded transition-colors disabled:opacity-50"
              disabled={saving}
            >
              {saving ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}