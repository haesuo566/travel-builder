import { Card } from "@/components/ui/Card";
import type { TripInfo } from "@/lib/types";

interface TripSummaryProps {
  summary: TripInfo;
}

export function TripSummary({ summary }: TripSummaryProps) {
  return (
    <Card className="flex flex-wrap items-center gap-x-8 gap-y-3 p-5">
      <div>
        <p className="text-xs text-slate-400">목적지</p>
        <p className="mt-0.5 font-semibold text-slate-900">
          {summary.destination}
        </p>
      </div>
      <div>
        <p className="text-xs text-slate-400">기간</p>
        <p className="mt-0.5 font-semibold text-slate-900">
          {summary.duration}
        </p>
      </div>
      <div>
        <p className="text-xs text-slate-400">인원</p>
        <p className="mt-0.5 font-semibold text-slate-900">
          {summary.travelers}
        </p>
      </div>
    </Card>
  );
}
