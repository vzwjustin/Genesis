"use client";

import { useState, useEffect } from "react";
import { Card, Button, Input, Modal, ConfirmModal, InlineAlert, EmptyState, CardSkeleton, Toggle, CopyButton } from "@/shared/components";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import { SECURITY_COPY } from "@/shared/constants/securityCopy";
import { useNotificationStore } from "@/store/notificationStore";
import { revealApiKey } from "@/shared/utils/revealApiKey";
import { maskApiKeyForDisplay } from "@/shared/utils/apiKeyDisplay";

export default function ApiKeysClient() {
  const notify = useNotificationStore();
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [createdKey, setCreatedKey] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [visibleKeys, setVisibleKeys] = useState(new Set());
  const [revealedKeys, setRevealedKeys] = useState({});

  const { copied, copy } = useCopyToClipboard();

  useEffect(() => {
    // eslint-disable-next-line react-hooks/immutability
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const keysRes = await fetch("/api/keys");
      const keysData = await keysRes.json();
      if (keysRes.ok) {
        setKeys(keysData.keys || []);
      }
    } catch (error) {
      notify.error(error.message || "Failed to load API keys");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) return;

    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName }),
      });
      const data = await res.json();

      if (res.ok) {
        setCreatedKey(data.key);
        await fetchData();
        setNewKeyName("");
        setShowAddModal(false);
        notify.success("API key created");
      } else {
        notify.error(data.error || "Failed to create API key");
      }
    } catch (error) {
      notify.error(error.message || "Failed to create API key");
    }
  };

  const handleDeleteKey = async (id) => {
    setConfirmState({
      title: "Delete API Key",
      message: "Delete this API key?",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
          if (res.ok) {
            setKeys(keys.filter((k) => k.id !== id));
            setVisibleKeys(prev => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
            notify.success("API key deleted");
          } else {
            const data = await res.json().catch(() => ({}));
            notify.error(data.error || "Failed to delete API key");
          }
        } catch (error) {
          notify.error(error.message || "Failed to delete API key");
        }
      }
    });
  };

  const handleToggleKey = async (id, isActive) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (res.ok) {
        setKeys(prev => prev.map(k => k.id === id ? { ...k, isActive } : k));
      } else {
        const data = await res.json().catch(() => ({}));
        notify.error(data.error || "Failed to update API key");
      }
    } catch (error) {
      notify.error(error.message || "Failed to update API key");
    }
  };

  const displayKey = (key) => {
    if (visibleKeys.has(key.id) && revealedKeys[key.id]) return revealedKeys[key.id];
    return key.key?.includes("…") ? key.key : maskApiKeyForDisplay(key.key);
  };

  const toggleKeyVisibility = async (keyId) => {
    if (visibleKeys.has(keyId)) {
      setVisibleKeys((prev) => {
        const next = new Set(prev);
        next.delete(keyId);
        return next;
      });
      return;
    }
    const full = revealedKeys[keyId] || await revealApiKey(keyId);
    if (!full) return;
    setRevealedKeys((prev) => ({ ...prev, [keyId]: full }));
    setVisibleKeys((prev) => new Set(prev).add(keyId));
    setTimeout(() => {
      setVisibleKeys((prev) => {
        const next = new Set(prev);
        next.delete(keyId);
        return next;
      });
    }, 30000);
  };

  const revealKeyForCopy = async (key) => {
    const full = revealedKeys[key.id] || await revealApiKey(key.id);
    if (full) setRevealedKeys((prev) => ({ ...prev, [key.id]: full }));
    return full;
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-8">
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold tracking-tight flex items-center gap-2">
            <span className="material-symbols-outlined text-text-muted">vpn_key</span>
            API Keys
          </h2>
          <Button icon="add" onClick={() => setShowAddModal(true)}>
            Create Key
          </Button>
        </div>

        <p className="text-xs text-text-muted mb-3">{SECURITY_COPY.apiKeysMasked}</p>
        {keys.length === 0 ? (
          <EmptyState
            icon="vpn_key"
            title="No API keys yet"
            description="Create your first API key to get started"
            action={{ label: "Create Key", onClick: () => setShowAddModal(true) }}
          />
        ) : (
          <div className="flex flex-col">
            {keys.map((key) => (
              <div
                key={key.id}
                className={`group flex items-center justify-between py-3 border-b border-border-subtle last:border-b-0 dashboard-row-hover transition-colors ${key.isActive === false ? "opacity-60" : ""}`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{key.name}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <code className="text-xs text-text-muted font-mono">
                      {displayKey(key)}
                    </code>
                    <button
                      onClick={() => toggleKeyVisibility(key.id)}
                      className="rounded p-1 text-text-muted opacity-100 transition-all dashboard-row-hover hover:text-text-main sm:group-hover:opacity-100 sm:opacity-0"
                      title={visibleKeys.has(key.id) ? "Hide key" : "Show key"}
                      aria-label={visibleKeys.has(key.id) ? "Hide key" : "Show key"}
                    >
                      <span className="material-symbols-outlined text-[14px]">
                        {visibleKeys.has(key.id) ? "visibility_off" : "visibility"}
                      </span>
                    </button>
                    <CopyButton
                      getValue={() => revealKeyForCopy(key)}
                      size="sm"
                      ariaLabel="Copy API key"
                      className="opacity-100 transition-all sm:group-hover:opacity-100 sm:opacity-0"
                    />
                  </div>
                  <p className="text-xs text-text-muted mt-1">
                    Created {new Date(key.createdAt).toLocaleDateString()}
                  </p>
                  {key.isActive === false && (
                    <p className="text-xs text-warning mt-1">Paused</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Toggle
                    size="sm"
                    checked={key.isActive ?? true}
                    onChange={(checked) => {
                      if (key.isActive && !checked) {
                        setConfirmState({
                          title: "Pause API Key",
                          message: `Pause API key "${key.name}"?\n\nThis key will stop working immediately but can be resumed later.`,
                          onConfirm: async () => {
                            setConfirmState(null);
                            handleToggleKey(key.id, checked);
                          }
                        });
                      } else {
                        handleToggleKey(key.id, checked);
                      }
                    }}
                    title={key.isActive ? "Pause key" : "Resume key"}
                  />
                  <button
                    onClick={() => handleDeleteKey(key.id)}
                    className="p-2 hover:bg-danger/10 rounded text-danger opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all"
                    aria-label="Delete API key"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Add Key Modal */}
      <Modal
        isOpen={showAddModal}
        title="Create API Key"
        onClose={() => {
          setShowAddModal(false);
          setNewKeyName("");
        }}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Key Name"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="Production Key"
          />
          <div className="flex gap-2">
            <Button onClick={handleCreateKey} fullWidth disabled={!newKeyName.trim()}>
              Create
            </Button>
            <Button
              onClick={() => {
                setShowAddModal(false);
                setNewKeyName("");
              }}
              variant="ghost"
              fullWidth
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* Created Key Modal */}
      <Modal
        isOpen={!!createdKey}
        title="API Key Created"
        onClose={() => setCreatedKey(null)}
      >
        <div className="flex flex-col gap-4">
          <InlineAlert
            variant="caution"
            title="Save this key now!"
            message="This is the only time you will see this key. Store it securely."
          />
          <div className="flex gap-2">
            <Input
              value={createdKey || ""}
              readOnly
              className="flex-1 font-mono text-sm"
            />
            <Button
              variant="secondary"
              icon={copied === "created_key" ? "check" : "content_copy"}
              onClick={() => copy(createdKey, "created_key")}
            >
              {copied === "created_key" ? "Copied!" : "Copy"}
            </Button>
          </div>
          <Button onClick={() => setCreatedKey(null)} fullWidth>
            Done
          </Button>
        </div>
      </Modal>

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </div>
  );
}
