import { Card } from "@/components/ui/Card";

const STEPS = [
  {
    number: "01",
    title: "대화로 취향 알려주기",
    description: "목적지, 기간, 인원, 취향을 채팅으로 편하게 이야기해주세요.",
  },
  {
    number: "02",
    title: "AI가 실데이터로 일정 생성",
    description: "한국관광공사 공공 데이터를 바탕으로 맞춤 일정을 만들어드려요.",
  },
  {
    number: "03",
    title: "지도·타임라인으로 확인/수정",
    description: "Day별 타임라인과 지도로 동선을 확인하고 자유롭게 수정하세요.",
  },
];

export function HowItWorks() {
  return (
    <section className="mx-auto max-w-5xl px-6 py-20">
      <h2 className="text-center text-3xl font-semibold text-slate-900">
        이렇게 만들어져요
      </h2>
      <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-3">
        {STEPS.map((step) => (
          <Card key={step.number} className="p-8">
            <span className="text-sm font-semibold text-brand">
              {step.number}
            </span>
            <h3 className="mt-3 text-lg font-semibold text-slate-900">
              {step.title}
            </h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              {step.description}
            </p>
          </Card>
        ))}
      </div>
    </section>
  );
}
