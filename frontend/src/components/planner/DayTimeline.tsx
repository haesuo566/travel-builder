import { PlaceCard } from "./PlaceCard";
import type { Place } from "@/lib/types";

interface DayTimelineProps {
  places: Place[];
}

export function DayTimeline({ places }: DayTimelineProps) {
  return (
    <ol className="relative space-y-4 border-l-2 border-teal-100 pl-6">
      {places.map((place) => (
        <li key={place.id} className="relative">
          <span className="absolute -left-[31px] top-5 h-2.5 w-2.5 rounded-full bg-brand" />
          <PlaceCard place={place} />
        </li>
      ))}
    </ol>
  );
}
