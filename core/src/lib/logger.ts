/**
 * CLI 전역 출력 헬퍼. 명령들은 console.* 대신 이 모듈을 사용한다.
 */
export const logger = {
  info(message: string): void {
    console.log(message);
  },
  error(message: string): void {
    console.error(message);
  },
};
