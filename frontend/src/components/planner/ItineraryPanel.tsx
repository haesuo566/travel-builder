"use client";

import { useState } from "react";
import type { Itinerary } from "@/lib/types";
import { TripSummary } from "./TripSummary";
import { DayTimeline } from "./DayTimeline";
import { MapPlaceholder } from "./MapPlaceholder";

interface ItineraryPanelProps {
  itinerary: Itinerary;
}

export function ItineraryPanel({ itinerary }: ItineraryPanelProps) {
  const [selectedDayIndex, setSelectedDayIndex] = useState(0);

  const days = itinerary.days;
  const activeDay = days[Math.min(selectedDayIndex, days.length - 1)];

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-6">
      <TripSummary summary={itinerary.summary} />

      <div className="flex gap-2">
        {days.map((day, index) => (
          <button
            key={day.day}
            type="button"
            onClick={() => setSelectedDayIndex(index)}
            className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
              index === selectedDayIndex
                ? "bg-brand text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            Day {day.day}
          </button>
        ))}
      </div>

      <MapPlaceholder places={activeDay.places} />
      <DayTimeline places={activeDay.places} />
    </div>
  );
}
