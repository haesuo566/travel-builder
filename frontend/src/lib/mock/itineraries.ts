import type { Itinerary } from "../types";

export const itinerariesByDestination: Record<string, Itinerary> = {
  seoul: {
    summary: {
      destination: "서울",
      duration: "2박 3일",
      travelers: "성인 2명",
    },
    days: [
      {
        day: 1,
        places: [
          {
            id: "seoul-1-1",
            name: "경복궁",
            category: "관광지",
            time: "10:00",
            description: "조선 왕조의 정궁으로, 수문장 교대식이 볼거리예요.",
            pinNumber: 1,
          },
          {
            id: "seoul-1-2",
            name: "광장시장",
            category: "음식점",
            time: "12:30",
            description: "빈대떡과 마약김밥으로 유명한 전통시장 먹거리 골목이에요.",
            pinNumber: 2,
          },
          {
            id: "seoul-1-3",
            name: "신라스테이 명동",
            category: "숙박",
            time: "20:00",
            description: "명동 중심가에서 도보로 이동하기 좋은 숙소예요.",
            pinNumber: 3,
          },
        ],
      },
      {
        day: 2,
        places: [
          {
            id: "seoul-2-1",
            name: "북촌한옥마을",
            category: "관광지",
            time: "09:30",
            description: "전통 한옥이 모여있는 골목을 산책하며 사진 찍기 좋아요.",
            pinNumber: 1,
          },
          {
            id: "seoul-2-2",
            name: "을지로 노포 골목",
            category: "음식점",
            time: "13:00",
            description: "노가리와 계란말이로 유명한 오래된 노포들이 모여있어요.",
            pinNumber: 2,
          },
          {
            id: "seoul-2-3",
            name: "남산서울타워",
            category: "관광지",
            time: "18:00",
            description: "서울 시내 전망과 야경을 한눈에 볼 수 있어요.",
            pinNumber: 3,
          },
          {
            id: "seoul-2-4",
            name: "신라스테이 명동",
            category: "숙박",
            time: "21:30",
            description: "둘째 날도 같은 숙소에서 편하게 머물러요.",
            pinNumber: 4,
          },
        ],
      },
      {
        day: 3,
        places: [
          {
            id: "seoul-3-1",
            name: "인사동 쌈지길",
            category: "관광지",
            time: "10:00",
            description: "전통 공예품과 기념품을 구경하기 좋은 거리예요.",
            pinNumber: 1,
          },
          {
            id: "seoul-3-2",
            name: "명동교자",
            category: "음식점",
            time: "12:00",
            description: "칼국수와 만두로 유명한 명동 대표 맛집이에요.",
            pinNumber: 2,
          },
        ],
      },
    ],
  },
  busan: {
    summary: {
      destination: "부산",
      duration: "2박 3일",
      travelers: "성인 2명",
    },
    days: [
      {
        day: 1,
        places: [
          {
            id: "busan-1-1",
            name: "해운대해수욕장",
            category: "관광지",
            time: "11:00",
            description: "부산을 대표하는 해변으로 산책하기 좋아요.",
            pinNumber: 1,
          },
          {
            id: "busan-1-2",
            name: "해운대 포장마차촌",
            category: "음식점",
            time: "18:00",
            description: "해산물과 부산 대표 포장마차 감성을 즐길 수 있어요.",
            pinNumber: 2,
          },
          {
            id: "busan-1-3",
            name: "파라다이스 호텔 부산",
            category: "숙박",
            time: "21:00",
            description: "해운대 해변 바로 앞에 위치한 숙소예요.",
            pinNumber: 3,
          },
        ],
      },
      {
        day: 2,
        places: [
          {
            id: "busan-2-1",
            name: "자갈치시장",
            category: "관광지",
            time: "09:30",
            description: "부산의 대표 수산시장으로 신선한 해산물을 구경할 수 있어요.",
            pinNumber: 1,
          },
          {
            id: "busan-2-2",
            name: "부평깡통시장",
            category: "음식점",
            time: "12:30",
            description: "다양한 길거리 음식을 즐길 수 있는 야시장으로 유명해요.",
            pinNumber: 2,
          },
          {
            id: "busan-2-3",
            name: "감천문화마을",
            category: "관광지",
            time: "15:30",
            description: "알록달록한 계단식 마을로 사진 명소로 유명해요.",
            pinNumber: 3,
          },
          {
            id: "busan-2-4",
            name: "파라다이스 호텔 부산",
            category: "숙박",
            time: "21:00",
            description: "둘째 날도 같은 숙소에서 편하게 머물러요.",
            pinNumber: 4,
          },
        ],
      },
      {
        day: 3,
        places: [
          {
            id: "busan-3-1",
            name: "광안리해수욕장",
            category: "관광지",
            time: "10:00",
            description: "광안대교 전망이 아름다운 해변이에요.",
            pinNumber: 1,
          },
          {
            id: "busan-3-2",
            name: "삼진어묵 본점",
            category: "음식점",
            time: "12:00",
            description: "부산 대표 어묵 맛집으로 다양한 어묵 요리를 맛볼 수 있어요.",
            pinNumber: 2,
          },
        ],
      },
    ],
  },
  jeju: {
    summary: {
      destination: "제주",
      duration: "2박 3일",
      travelers: "성인 2명",
    },
    days: [
      {
        day: 1,
        places: [
          {
            id: "jeju-1-1",
            name: "성산일출봉",
            category: "관광지",
            time: "09:00",
            description: "유네스코 세계자연유산으로 일출 명소로 유명해요.",
            pinNumber: 1,
          },
          {
            id: "jeju-1-2",
            name: "성산포 해녀의 집",
            category: "음식점",
            time: "12:00",
            description: "해녀가 직접 잡은 신선한 해산물을 맛볼 수 있어요.",
            pinNumber: 2,
          },
          {
            id: "jeju-1-3",
            name: "제주신라호텔",
            category: "숙박",
            time: "20:00",
            description: "중문관광단지에 위치한 리조트형 숙소예요.",
            pinNumber: 3,
          },
        ],
      },
      {
        day: 2,
        places: [
          {
            id: "jeju-2-1",
            name: "주상절리대",
            category: "관광지",
            time: "09:30",
            description: "육각형 돌기둥이 절경을 이루는 해안 명소예요.",
            pinNumber: 1,
          },
          {
            id: "jeju-2-2",
            name: "흑돼지거리",
            category: "음식점",
            time: "12:30",
            description: "제주 흑돼지 구이로 유명한 맛집 거리예요.",
            pinNumber: 2,
          },
          {
            id: "jeju-2-3",
            name: "협재해수욕장",
            category: "관광지",
            time: "16:00",
            description: "에메랄드빛 바다와 백사장이 아름다운 해변이에요.",
            pinNumber: 3,
          },
          {
            id: "jeju-2-4",
            name: "제주신라호텔",
            category: "숙박",
            time: "20:30",
            description: "둘째 날도 같은 숙소에서 편하게 머물러요.",
            pinNumber: 4,
          },
        ],
      },
      {
        day: 3,
        places: [
          {
            id: "jeju-3-1",
            name: "한라산 어리목 탐방로",
            category: "관광지",
            time: "09:00",
            description: "가볍게 걸을 수 있는 한라산 초입 탐방로예요.",
            pinNumber: 1,
          },
          {
            id: "jeju-3-2",
            name: "올레국수",
            category: "음식점",
            time: "12:00",
            description: "제주 멸치국수로 유명한 로컬 맛집이에요.",
            pinNumber: 2,
          },
        ],
      },
    ],
  },
};

const DEFAULT_DESTINATION_KEY = "seoul";

const DESTINATION_KEYWORDS: Record<string, string> = {
  서울: "seoul",
  부산: "busan",
  제주도: "jeju",
  제주: "jeju",
};

export function getDefaultItinerary(): Itinerary {
  return itinerariesByDestination[DEFAULT_DESTINATION_KEY];
}

export function getItineraryByDestinationKey(key: string): Itinerary {
  return itinerariesByDestination[key];
}

export function findDestinationKeyForMessage(message: string): string | null {
  for (const [keyword, key] of Object.entries(DESTINATION_KEYWORDS)) {
    if (message.includes(keyword)) {
      return key;
    }
  }
  return null;
}
