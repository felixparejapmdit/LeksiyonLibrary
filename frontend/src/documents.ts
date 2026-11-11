export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const LESSON_FILE_ACCEPT = `.pdf,.docx,application/pdf,${DOCX_MIME}`;

export const isDocxFileName = (name: string) => /\.docx$/i.test(name);

export function isLessonFile(file: Pick<File, 'name' | 'type'>) {
  return /\.(?:pdf|docx)$/i.test(file.name) || file.type === 'application/pdf';
}

export const documentLabel = (lesson: { file_name: string }) => isDocxFileName(lesson.file_name) ? 'DOCX' : 'PDF';
