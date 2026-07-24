import { Button } from "@/components/ui/Button";
import { BRAND_NAME, BRAND_TAGLINE } from "@/lib/constants";

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-b from-brand-light to-white px-6 py-24 sm:py-32">
      <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <span className="mb-4 inline-flex items-center rounded-full bg-white px-4 py-1.5 text-sm font-medium text-brand shadow-sm">
          {BRAND_NAME}
        </span>
        <h1 className="text-4xl font-bold tracking-tight text-slate-900 sm:text-5xl">
          {BRAND_TAGLINE}
        </h1>
        <p className="mt-6 max-w-xl text-lg leading-8 text-slate-600">
          대화 몇 마디로 목적지, 기간, 취향에 맞는 여행 일정을 AI가 바로
          만들어드려요.
        </p>
        <div className="mt-10">
          <Button href="/plan" size="lg">
            여행 계획 시작하기
          </Button>
        </div>
      </div>
    </section>
  );
}
