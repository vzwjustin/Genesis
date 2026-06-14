import BasicChatPageClient from "./BasicChatPageClient";

export default function BasicChatPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-3 lg:p-5">
      <div className="glass-panel flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border shadow-[var(--shadow-soft)]">
        <BasicChatPageClient />
      </div>
    </div>
  );
}