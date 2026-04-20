export interface FssDocumentSummary {
  id: number;
  path: string;
  directory: string;
  filename: string;
  extension: string;
  file_size: number;
  file_mtime: string;
  parsed_at: string;
}

export interface FssDocumentDetail extends FssDocumentSummary {
  parse_status: 'success' | 'error' | 'skip';
  error_msg: string;
  body_text: string;
}
