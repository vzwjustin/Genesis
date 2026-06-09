import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components";
import MitmPageClient from "./MitmPageClient";

export default function MitmPage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <MitmPageClient />
    </Suspense>
  );
}
