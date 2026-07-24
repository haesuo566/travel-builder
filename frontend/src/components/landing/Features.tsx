import { Card } from "@/components/ui/Card";

const FEATURES = [
  {
    title: "공공 관광 실데이터 기반",
    description: "한국관광공사 TourAPI 데이터로 신뢰할 수 있는 정보를 제공해요.",
  },
  {
    title: "AI 맞춤 추천",
    description: "대화 맥락을 이해해 취향에 맞는 장소를 추천해요.",
  },
  {
    title: "지도 중심 동선",
    description: "Day별 동선을 지도와 타임라인으로 한눈에 확인해요.",
  },
];

export function Features() {
  return (
    <section className="bg-slate-50 px-6 py-20">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center text-3xl font-semibold text-slate-900">
          여로만의 특징
        </h2>
        <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-3">
          {FEATURES.map((feature) => (
            <Card key={feature.title} className="p-8">
              <h3 className="text-lg font-semibold text-slate-900">
                {feature.title}
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">
                {feature.description}
              </p>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
