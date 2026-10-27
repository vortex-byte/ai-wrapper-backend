/** Minimal CSV parsing/serialization for the user-import feature. */

export interface CsvRow {
  readonly email: string;
  readonly name: string;
  readonly division?: string | undefined;
}

function splitLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Parses CSV text with a fixed `email,name,division` header. Column order is free and
 * matching is case-insensitive; the delimiter is auto-detected (`,` or `;`). Lines with
 * fewer fields than the header are treated as missing trailing columns. Returns the data
 * rows plus 1-based row numbers of lines that could not be mapped to the header.
 */
export function parseCsv(text: string): { rows: CsvRow[]; malformed: number[] } {
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = cleaned.split(/\r\n|\n|\r/).filter((line) => line.trim() !== '');
  if (lines.length === 0) return { rows: [], malformed: [] };

  const delimiter = (lines[0]?.match(/;/g)?.length ?? 0) > (lines[0]?.match(/,/g)?.length ?? 0) ? ';' : ',';
  const headers = splitLine(lines[0] ?? '', delimiter).map((h) => h.trim().toLowerCase());
  const emailIndex = headers.indexOf('email');
  const nameIndex = headers.indexOf('name');
  const divisionIndex = headers.indexOf('division');
  if (emailIndex === -1 || nameIndex === -1) {
    return { rows: [], malformed: [] };
  }

  const rows: CsvRow[] = [];
  const malformed: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = splitLine(lines[i] ?? '', delimiter);
    const email = (fields[emailIndex] ?? '').trim();
    const name = (fields[nameIndex] ?? '').trim();
    if (email === '' && name === '') continue;
    if (email === '' || name === '') {
      malformed.push(i + 1);
      continue;
    }
    rows.push({
      email,
      name,
      ...(divisionIndex !== -1 && divisionIndex < fields.length
        ? { division: (fields[divisionIndex] ?? '').trim() }
        : {}),
    });
  }
  return { rows, malformed };
}

export const CSV_TEMPLATE_CONTENT = '\uFEFFemail,name,division\nbudi.santoso@kantor.example.com,Budi Santoso,ENG-01\nsiti.aminah@kantor.example.com,Siti Aminah,HR-CORP\n';
export const CSV_TEMPLATE_FILENAME = 'template_registrasi_pengguna.csv';
