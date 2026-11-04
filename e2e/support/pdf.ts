// Builds small, valid PDFs with a real text layer for fast tests.
export function makePdf(pages: string[][]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add(''); // Pages placeholder.
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (const lines of pages) {
    const safe = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const content = `BT /F1 11 Tf 50 780 Td 15 TL ${lines.map((l) => `(${safe(l)}) Tj T*`).join(' ')} ET`;
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const page = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${stream} 0 R >>`);
    kids.push(page);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export const midweekLesson = {
  name: '2025_Wk42a.pdf',
  mimeType: 'application/pdf',
  buffer: makePdf([
    [
      'Wednesday/Thursday: October 15/16, 2025',
      'Paksa: Ang Halimbawa ng Pagbabantay sa mga Huling Araw',
      'Pasimula: Ano ang ipinagpauna ng Banal na Kasulatan?',
      'Darating ang mga panahong mapanganib kung saan ang mga tao ay maging mga maibigin sa sarili.',
      'Talata: 2 Timoteo 3:1-5',
      'Talata: 1 Tesalonica 5:1-6 MB2012',
    ],
    ['Pahina dalawa ng pagbabantay.', 'Talata: Mateo 24:42-44 MB2012', 'Ang pagpupuyat at ang panalangin ay kailangan.'],
    ['Pahina tatlo ng aralin.', 'Talata: Juan 15:16'],
  ]),
};

export const pastoralLesson = {
  name: '20150425_Sampleville, Testland_Ang Halimbawa ng Tungkulin.pdf',
  mimeType: 'application/pdf',
  buffer: makePdf([
    [
      'Pastoral Visit Outline',
      'Paksa: Ang Halimbawa ng Tungkulin at Halimbawang Paksa',
      'Hindi kayo ang pumili sa Akin kundi Ako ang pumili sa inyo.',
      'Talata: Juan 15:16',
      'Talata: Colosas 3:23-24',
    ],
  ]),
};

export const weekendEnglishLesson = {
  name: '2024_Wk41b.pdf',
  mimeType: 'application/pdf',
  buffer: makePdf([
    [
      'Saturday/Sunday: October 12/13, 2024',
      'Paksa: Sampleday Is at Hand So We Should Prepare',
      'The strict instruction of our Lord to his disciples concerning his nearing return.',
      'Talata: Matt. 24:36 & 44 GNT',
      'Talata: Rev. 14:10-11(a) ESV',
      'A unique searchable phrase: zephyrword appears only in this body.',
    ],
  ]),
};

export const notAPdf = { name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('this is plainly not a pdf file') };
export const textFile = { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') };
