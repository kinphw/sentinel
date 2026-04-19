export type 구분Type = '법령해석' | '비조치의견서' | '현장건의 과제';

export interface InterpretationSummary {
  id: number;
  구분: string;
  분야: string;
  제목: string;
  회신일자: string;
  일련번호: string;
}

export interface InterpretationDetail extends InterpretationSummary {
  회신부서: string;
  질의요지: string;
  회답: string;
  이유: string;
}
