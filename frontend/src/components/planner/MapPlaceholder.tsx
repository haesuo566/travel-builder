import type { Place } from "@/lib/types";

interface MapPlaceholderProps {
  places: Place[];
}

export function MapPlaceholder({ places }: MapPlaceholderProps) {
  return (
    <div className="relative h-56 w-full overflow-hidden rounded-2xl bg-teal-50">
      <div
        className="absolute inset-0 opacity-40"
        style={{
          backgroundImage: "radial-gradient(circle, #0d9488 1px, transparent 1px)",
          backgroundSize: "18px 18px",
        }}
      />
      <div className="relative flex h-full flex-wrap items-center justify-center gap-6 p-6">
        {places.map((place) => (
          <div key={place.id} className="flex flex-col items-center gap-1">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-sm font-semibold text-white shadow-md">
              {place.pinNumber}
            </div>
            <span className="max-w-[72px] truncate text-xs text-slate-600">
              {place.name}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
