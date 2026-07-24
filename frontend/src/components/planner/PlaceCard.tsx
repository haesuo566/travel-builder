import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import type { Place, PlaceCategory } from "@/lib/types";

const CATEGORY_GRADIENTS: Record<PlaceCategory, string> = {
  관광지: "from-teal-400 to-teal-600",
  음식점: "from-amber-400 to-amber-600",
  숙박: "from-sky-400 to-sky-600",
};

interface PlaceCardProps {
  place: Place;
}

export function PlaceCard({ place }: PlaceCardProps) {
  return (
    <Card className="flex gap-4 p-4">
      <div
        className={`relative flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-lg font-semibold text-white ${CATEGORY_GRADIENTS[place.category]}`}
      >
        {place.name.slice(0, 1)}
        <span className="absolute -bottom-2 -right-2 flex h-6 w-6 items-center justify-center rounded-full bg-white text-xs font-semibold text-slate-700 shadow">
          {place.pinNumber}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <h4 className="truncate font-semibold text-slate-900">
            {place.name}
          </h4>
          <span className="shrink-0 text-xs text-slate-400">{place.time}</span>
        </div>
        <div className="mt-1.5">
          <Badge category={place.category} />
        </div>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          {place.description}
        </p>
      </div>
    </Card>
  );
}
