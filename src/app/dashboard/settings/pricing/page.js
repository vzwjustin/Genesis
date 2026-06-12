"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Card from "@/shared/components/Card";
import PricingModal from "@/shared/components/PricingModal";
import { useNotificationStore } from "@/store/notificationStore";

export default function PricingSettingsPage() {
  const router = useRouter();
  const notify = useNotificationStore();
  const [showModal, setShowModal] = useState(false);
  const [currentPricing, setCurrentPricing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const loadPricing = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/pricing");
      if (response.ok) {
        const data = await response.json();
        setCurrentPricing(data);
      } else {
        const error = await response.json().catch(() => ({}));
        const message = error.error || "Failed to load pricing";
        setLoadError(message);
        setCurrentPricing(null);
        notify.error(message);
      }
    } catch (error) {
      console.error("Failed to load pricing:", error);
      const message = error?.message || "Failed to load pricing";
      setLoadError(message);
      setCurrentPricing(null);
      notify.error(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPricing();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePricingUpdated = () => {
    loadPricing();
  };

  // Count total models with pricing
  const getModelCount = () => {
    if (!currentPricing) return 0;
    let count = 0;
    for (const provider in currentPricing) {
      count += Object.keys(currentPricing[provider]).length;
    }
    return count;
  };

  // Get providers list
  const getProviders = () => {
    if (!currentPricing) return [];
    return Object.keys(currentPricing).sort((a, b) => {
      if (a === "models") return -1;
      if (b === "models") return 1;
      return a.localeCompare(b);
    });
  };

  const formatProviderLabel = (provider) => (
    provider === "models" ? "Canonical models" : provider.toUpperCase()
  );

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Pricing Settings</h1>
          <p className="text-text-muted mt-1">
            Configure pricing rates for cost tracking and calculations
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-primary text-white rounded hover:bg-primary/90 transition-colors"
        >
          Edit Pricing
        </button>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="text-text-muted text-sm uppercase font-semibold">
            Total Models
          </div>
          <div className="text-2xl font-bold mt-1">
            {loading ? "..." : getModelCount()}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-text-muted text-sm uppercase font-semibold">
            Providers
          </div>
          <div className="text-2xl font-bold mt-1">
            {loading ? "..." : getProviders().length}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-text-muted text-sm uppercase font-semibold">
            Status
          </div>
          <div className={`text-2xl font-bold mt-1 ${loadError ? "text-danger" : "text-success"}`}>
            {loading ? "..." : loadError ? "Error" : "Active"}
          </div>
        </Card>
      </div>

      {/* Info Section */}
      <Card className="p-6">
        <h2 className="text-xl font-semibold mb-4">How Pricing Works</h2>
        <div className="space-y-3 text-sm text-text-muted">
          <p>
            A <strong>token</strong> is a small chunk of text (roughly ¾ of a word). Models bill by the number of tokens they read and write.
          </p>
          <p>
            <strong>Cost Calculation:</strong> Each request&apos;s cost adds up the tokens it used at each rate:
            (input tokens × input rate) + (output tokens × output rate) + (cached tokens × cached rate)
          </p>
          <p>
            <strong>Pricing Format:</strong> All rates are in <strong>dollars per million tokens</strong> ($/1M tokens).
            Example: An input rate of 2.50 means $2.50 per 1,000,000 input tokens.
          </p>
          <p>
            <strong>Token Types:</strong>
          </p>
          <ul className="list-disc list-inside ml-4 space-y-1">
            <li><strong>Input:</strong> Tokens in the prompt you send</li>
            <li><strong>Output:</strong> Tokens in the model&apos;s reply</li>
            <li><strong>Cached:</strong> Input tokens reused from an earlier request (usually cheaper than fresh input)</li>
            <li><strong>Reasoning:</strong> Internal &quot;thinking&quot; tokens some models use (billed at the output rate if no separate rate is set)</li>
            <li><strong>Cache Creation:</strong> Tokens spent saving content so it can be reused later (billed at the input rate if no separate rate is set)</li>
          </ul>
          <p>
            <strong>Custom Pricing:</strong> You can override default pricing for specific models.
            Reset to defaults anytime to restore standard rates.
          </p>
        </div>
      </Card>

      {/* Current Pricing Preview */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold">Current Pricing Overview</h2>
          <button
            onClick={() => setShowModal(true)}
            className="text-primary hover:underline text-sm"
          >
            View Full Details
          </button>
        </div>

        {loading ? (
          <div className="text-center py-4 text-text-muted">Loading pricing data...</div>
        ) : loadError ? (
          <div className="text-center py-4 text-danger">{loadError}</div>
        ) : currentPricing ? (
          <div className="space-y-3">
            {Object.keys(currentPricing).slice(0, 5).map(provider => (
              <div key={provider} className="text-sm">
                <span className="font-semibold">{formatProviderLabel(provider)}:</span>{" "}
                <span className="text-text-muted">
                  {Object.keys(currentPricing[provider]).length} models
                </span>
              </div>
            ))}
            {Object.keys(currentPricing).length > 5 && (
              <div className="text-sm text-text-muted">
                + {Object.keys(currentPricing).length - 5} more providers
              </div>
            )}
          </div>
        ) : (
          <div className="text-text-muted">No pricing data available</div>
        )}
      </Card>

      {/* Pricing Modal */}
      {showModal && (
        <PricingModal
          isOpen={showModal}
          onClose={() => setShowModal(false)}
          onSave={handlePricingUpdated}
        />
      )}
    </div>
  );
}