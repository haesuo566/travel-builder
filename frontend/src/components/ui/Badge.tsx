import type { PlaceCategory } from "@/lib/types";

const CATEGORY_CLASSES: Record<PlaceCategory, string> = {
  관광지: "bg-teal-50 text-teal-700",
  음식점: "bg-amber-50 text-amber-700",
  숙박: "bg-sky-50 text-sky-700",
};

interface BadgeProps {
  category: PlaceCategory;
}

export function Badge({ category }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${CATEGORY_CLASSES[category]}`}
    >
      {category}
    </span>
  );
}
