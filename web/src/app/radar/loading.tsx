import { Skeleton } from "@/components/ui/skeleton";

export default function RadarLoading() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-8" aria-label="Loading radar">
      <div className="flex items-center gap-3">
        <Skeleton className="size-6 rounded-full" />
        <Skeleton className="h-8 w-28" />
      </div>
      <Skeleton className="mt-3 h-4 w-full max-w-2xl" />
      <Skeleton className="mt-2 h-4 w-4/5 max-w-2xl" />
      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
      <div className="mt-5 flex gap-2">
        <Skeleton className="h-9 w-64 rounded-full" />
        <Skeleton className="h-9 w-32 rounded-full" />
        <Skeleton className="h-9 w-32 rounded-full" />
      </div>
      <Skeleton className="mt-4 h-72 rounded-2xl" />
    </div>
  );
}
