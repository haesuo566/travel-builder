import { BRAND_NAME, BRAND_NAME_EN } from "@/lib/constants";

export function Footer() {
  return (
    <footer className="border-t border-slate-100 px-6 py-10 text-center text-sm text-slate-500">
      <p>
        {BRAND_NAME} ({BRAND_NAME_EN}) — 대화만으로 완성되는 여행 일정
      </p>
    </footer>
  );
}
