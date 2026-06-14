"use client";

import { useState, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import { Modal, Button, Input } from "@/shared/components";

/**
 * Kiro Auth Method Selection Modal
 * Auto-detects token from AWS SSO cache or allows manual import
 */
export default function KiroAuthModal({ isOpen, onMethodSelect, onClose, existingConnectionId }) {
  const [selectedMethod, setSelectedMethod] = useState(null);
  const [idcStartUrl, setIdcStartUrl] = useState("");
  const [idcRegion, setIdcRegion] = useState("us-east-1");
  const [refreshToken, setRefreshToken] = useState("");
  const [error, setError] = useState(null);
  const [importing, setImporting] = useState(false);
  const [autoDetecting, setAutoDetecting] = useState(false);
  const [autoDetected, setAutoDetected] = useState(false);
  const [autoImporting, setAutoImporting] = useState(false);

  const importToken = useCallback(async (token) => {
    const res = await fetch("/api/oauth/kiro/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refreshToken: token.trim(),
        ...(existingConnectionId ? { existingConnectionId } : {}),
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Import failed");
    }
    return data;
  }, [existingConnectionId]);

  // Reset state when modal closes
  useEffect(() => {
    if (isOpen) return;
    setSelectedMethod(null);
    setError(null);
    setRefreshToken("");
    setAutoDetected(false);
    setAutoDetecting(false);
    setAutoImporting(false);
    setImporting(false);
  }, [isOpen]);

  // Try silent auto-import when modal opens
  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;

    const tryAutoImport = async () => {
      setAutoImporting(true);
      setError(null);

      try {
        const res = await fetch("/api/oauth/kiro/auto-import");
        const data = await res.json();
        if (cancelled) return;

        if (data.found) {
          setRefreshToken(data.refreshToken);
          setAutoDetected(true);
          setAutoImporting(true);
          const importData = await importToken(data.refreshToken);
          if (cancelled) return;
          onMethodSelect("import", { mitm: importData?.mitm });
          return;
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || "Auto-import failed");
        }
      } finally {
        if (!cancelled) {
          setAutoImporting(false);
        }
      }
    };

    tryAutoImport();
    return () => { cancelled = true; };
  }, [isOpen, importToken, onMethodSelect]);

  // Auto-detect token when import method is selected manually
  useEffect(() => {
    if (selectedMethod !== "import" || !isOpen || autoImporting) return;

    const autoDetect = async () => {
      setAutoDetecting(true);
      setError(null);
      setAutoDetected(false);

      try {
        const res = await fetch("/api/oauth/kiro/auto-import");
        const data = await res.json();

        if (data.found) {
          setRefreshToken(data.refreshToken);
          setAutoDetected(true);
        } else {
          setError(data.error || "Could not auto-detect token");
        }
      } catch {
        setError("Failed to auto-detect token");
      } finally {
        setAutoDetecting(false);
      }
    };

    autoDetect();
  }, [selectedMethod, isOpen, autoImporting]);

  const handleMethodSelect = (method) => {
    setSelectedMethod(method);
    setError(null);
  };

  const handleBack = () => {
    setSelectedMethod(null);
    setError(null);
  };

  const handleImportToken = async () => {
    if (!refreshToken.trim()) {
      setError("Please enter a refresh token");
      return;
    }

    setImporting(true);
    setError(null);

    try {
      const importData = await importToken(refreshToken);
      onMethodSelect("import", { mitm: importData?.mitm });
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  const handleIdcContinue = () => {
    if (!idcStartUrl.trim()) {
      setError("Please enter your IDC start URL");
      return;
    }
    onMethodSelect("idc", { startUrl: idcStartUrl.trim(), region: idcRegion });
  };

  const handleSocialLogin = (provider) => {
    onMethodSelect("social", { provider });
  };

  return (
    <Modal
      isOpen={isOpen}
      title={existingConnectionId ? "Reconnect Kiro" : "Connect Kiro"}
      onClose={onClose}
      size="lg"
    >
      <div className="flex flex-col gap-4">
        {autoImporting && !selectedMethod && (
          <div className="text-center py-6">
            <div className="size-16 mx-auto mb-4 rounded-full glass-stat border-0 flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-brand-500 animate-spin">
                progress_activity
              </span>
            </div>
            <h3 className="text-lg font-semibold mb-2">Importing from Kiro IDE...</h3>
            <p className="text-sm text-text-muted">
              Reading AWS SSO cache and validating your connection
            </p>
          </div>
        )}

        {/* Method Selection */}
        {!selectedMethod && !autoImporting && (
          <div className="space-y-3">
            <p className="text-sm text-text-muted mb-4">
              Choose your authentication method:
            </p>

            {/* AWS Builder ID */}
            <button
              onClick={() => onMethodSelect("builder-id")}
              className="w-full p-4 text-left glass-option-card transition-colors"
            >
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-brand-500 mt-0.5">shield</span>
                <div className="flex-1">
                  <h3 className="font-semibold mb-1">AWS Builder ID</h3>
                  <p className="text-sm text-text-muted">
                    Recommended for most users. Free AWS account required.
                  </p>
                </div>
              </div>
            </button>

            {/* AWS IAM Identity Center (IDC) */}
            <button
              onClick={() => handleMethodSelect("idc")}
              className="w-full p-4 text-left glass-option-card transition-colors"
            >
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-brand-500 mt-0.5">business</span>
                <div className="flex-1">
                  <h3 className="font-semibold mb-1">AWS IAM Identity Center</h3>
                  <p className="text-sm text-text-muted">
                    For enterprise users with custom AWS IAM Identity Center.
                  </p>
                </div>
              </div>
            </button>

            <button
              onClick={() => handleMethodSelect("social-google")}
              className="w-full p-4 text-left glass-option-card transition-colors"
            >
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-brand-500 mt-0.5">account_circle</span>
                <div className="flex-1">
                  <h3 className="font-semibold mb-1">Google Account</h3>
                  <p className="text-sm text-text-muted">
                    Login with your Google account (manual callback).
                  </p>
                </div>
              </div>
            </button>

            <button
              onClick={() => handleMethodSelect("social-github")}
              className="w-full p-4 text-left glass-option-card transition-colors"
            >
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-brand-500 mt-0.5">code</span>
                <div className="flex-1">
                  <h3 className="font-semibold mb-1">GitHub Account</h3>
                  <p className="text-sm text-text-muted">
                    Login with your GitHub account (manual callback).
                  </p>
                </div>
              </div>
            </button>

            {/* Import Token */}
            <button
              onClick={() => handleMethodSelect("import")}
              className="w-full p-4 text-left glass-option-card transition-colors"
            >
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-brand-500 mt-0.5">file_upload</span>
                <div className="flex-1">
                  <h3 className="font-semibold mb-1">Import Token</h3>
                  <p className="text-sm text-text-muted">
                    Paste refresh token from Kiro IDE.
                  </p>
                </div>
              </div>
            </button>
          </div>
        )}

        {/* IDC Configuration */}
        {selectedMethod === "idc" && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2">
                IDC Start URL <span className="text-danger">*</span>
              </label>
              <Input
                value={idcStartUrl}
                onChange={(e) => setIdcStartUrl(e.target.value)}
                placeholder="https://your-org.awsapps.com/start"
                className="font-mono text-sm"
              />
              <p className="text-xs text-text-muted mt-1">
                Your organization&apos;s AWS IAM Identity Center URL
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">
                AWS Region
              </label>
              <Input
                value={idcRegion}
                onChange={(e) => setIdcRegion(e.target.value)}
                placeholder="us-east-1"
                className="font-mono text-sm"
              />
              <p className="text-xs text-text-muted mt-1">
                AWS region for your Identity Center (default: us-east-1)
              </p>
            </div>

            {error && (
              <p className="text-sm text-danger">{error}</p>
            )}

            <div className="flex gap-2">
              <Button onClick={handleIdcContinue} fullWidth>
                Continue
              </Button>
              <Button onClick={handleBack} variant="ghost" fullWidth>
                Back
              </Button>
            </div>
          </div>
        )}

        {/* Social Login Info (Google) */}
        {selectedMethod === "social-google" && (
          <div className="space-y-4">
            <div className="bg-warning/10 p-4 rounded-lg border border-warning/20">
              <div className="flex gap-2">
                <span className="material-symbols-outlined text-warning">info</span>
                <div className="flex-1 text-sm">
                  <p className="font-medium text-text-main mb-1">
                    Manual Callback Required
                  </p>
                  <p className="text-text-muted">
                    After login, you&apos;ll need to copy the callback URL from your browser and paste it back here.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={() => handleSocialLogin("google")} fullWidth>
                Continue with Google
              </Button>
              <Button onClick={handleBack} variant="ghost" fullWidth>
                Back
              </Button>
            </div>
          </div>
        )}

        {/* Social Login Info (GitHub) */}
        {selectedMethod === "social-github" && (
          <div className="space-y-4">
            <div className="bg-warning/10 p-4 rounded-lg border border-warning/20">
              <div className="flex gap-2">
                <span className="material-symbols-outlined text-warning">info</span>
                <div className="flex-1 text-sm">
                  <p className="font-medium text-text-main mb-1">
                    Manual Callback Required
                  </p>
                  <p className="text-text-muted">
                    After login, you&apos;ll need to copy the callback URL from your browser and paste it back here.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={() => handleSocialLogin("github")} fullWidth>
                Continue with GitHub
              </Button>
              <Button onClick={handleBack} variant="ghost" fullWidth>
                Back
              </Button>
            </div>
          </div>
        )}

        {/* Import Token */}
        {selectedMethod === "import" && (
          <div className="space-y-4">
            {/* Auto-detecting state */}
            {autoDetecting && (
              <div className="text-center py-6">
                <div className="size-16 mx-auto mb-4 rounded-full glass-stat border-0 flex items-center justify-center">
                  <span className="material-symbols-outlined text-3xl text-brand-500 animate-spin">
                    progress_activity
                  </span>
                </div>
                <h3 className="text-lg font-semibold mb-2">Auto-detecting token...</h3>
                <p className="text-sm text-text-muted">
                  Reading from AWS SSO cache
                </p>
              </div>
            )}

            {/* Form (shown after auto-detect completes) */}
            {!autoDetecting && (
              <>
                {/* Success message if auto-detected */}
                {autoDetected && (
                  <div className="bg-success/10 p-3 rounded-lg border border-success/20">
                    <div className="flex gap-2">
                      <span className="material-symbols-outlined text-success">check_circle</span>
                      <p className="text-sm text-text-main">
                        Token auto-detected from Kiro IDE successfully!
                      </p>
                    </div>
                  </div>
                )}

                {/* Info message if not auto-detected */}
                {!autoDetected && !error && (
                  <div className="bg-info/10 p-3 rounded-lg border border-info/20">
                    <div className="flex gap-2">
                      <span className="material-symbols-outlined text-info">info</span>
                      <p className="text-sm text-text-main">
                        Kiro IDE not detected. Please paste your refresh token manually.
                      </p>
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium mb-2">
                    Refresh Token <span className="text-danger">*</span>
                  </label>
                  <Input
                    value={refreshToken}
                    onChange={(e) => setRefreshToken(e.target.value)}
                    placeholder="Token will be auto-filled..."
                    className="font-mono text-sm"
                  />
                </div>

                {error && (
                  <div className="bg-danger/10 p-3 rounded-lg border border-danger/20">
                    <p className="text-sm text-danger">{error}</p>
                  </div>
                )}

                <div className="flex gap-2">
                  <Button onClick={handleImportToken} fullWidth disabled={importing || !refreshToken.trim()}>
                    {importing ? "Importing..." : existingConnectionId ? "Reconnect" : "Import Token"}
                  </Button>
                  <Button onClick={handleBack} variant="ghost" fullWidth>
                    Back
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

KiroAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onMethodSelect: PropTypes.func.isRequired,
  onClose: PropTypes.func.isRequired,
  existingConnectionId: PropTypes.string,
};
