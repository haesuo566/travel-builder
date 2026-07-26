import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * 프론트엔드 frontend/src/lib/types.ts의 일정 타입을 그대로 옮긴 것이다.
 * 공유 패키지가 없어서 지금은 복제가 유일한 선택이고, 어긋나면
 * chat.controller.spec.ts의 계약 테스트가 잡는다.
 */

/** PlaceCategory 유니온과 같은 값이어야 한다. */
export const PLACE_CATEGORIES = ['관광지', '음식점', '숙박'] as const;

export type PlaceCategory = (typeof PLACE_CATEGORIES)[number];

export class PlaceDto {
  @IsString()
  @IsNotEmpty()
  id: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsIn(PLACE_CATEGORIES)
  category: PlaceCategory;

  /** "09:00"처럼 화면에 그대로 찍히는 표시용 문자열. 포맷은 강제하지 않는다. */
  @IsString()
  @IsNotEmpty()
  time: string;

  @IsString()
  description: string;

  /** 지도 핀 번호. 1부터 시작한다. */
  @IsInt()
  @Min(1)
  pinNumber: number;
}

export class ItineraryDayDto {
  @IsInt()
  @Min(1)
  day: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PlaceDto)
  places: PlaceDto[];
}

export class TripInfoDto {
  @IsString()
  @IsNotEmpty()
  destination: string;

  @IsString()
  @IsNotEmpty()
  duration: string;

  @IsString()
  @IsNotEmpty()
  travelers: string;
}

export class ItineraryDto {
  // @ValidateNested 단독으로는 값이 없을 때 통과해버린다. @IsObject를 같이 걸어야
  // summary 누락이 400으로 잡힌다. (배열 쪽은 @IsArray가 같은 역할을 한다.)
  @IsObject()
  @ValidateNested()
  @Type(() => TripInfoDto)
  summary: TripInfoDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ItineraryDayDto)
  days: ItineraryDayDto[];
}
