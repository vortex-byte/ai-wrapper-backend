import { describe, expect, it } from 'vitest';
import { parseCsv } from '@/admin/http/csv.ts';

describe('parseCsv', () => {
  it('parses comma-separated rows in fixed header order', () => {
    const result = parseCsv('email,name,division\na@x.example,A,ENG-01\nb@x.example,B\n');
    expect(result.rows).toEqual([
      { email: 'a@x.example', name: 'A', division: 'ENG-01' },
      { email: 'b@x.example', name: 'B' },
    ]);
    expect(result.malformed).toEqual([]);
  });

  it('accepts free column order and case-insensitive headers', () => {
    const result = parseCsv('Division;Name;Email\nENG-01;A;a@x.example\n');
    expect(result.rows).toEqual([{ email: 'a@x.example', name: 'A', division: 'ENG-01' }]);
  });

  it('strips a UTF-8 BOM', () => {
    const result = parseCsv('\uFEFFemail,name\na@x.example,A\n');
    expect(result.rows).toEqual([{ email: 'a@x.example', name: 'A' }]);
  });

  it('supports quoted fields with delimiters and escaped quotes', () => {
    const result = parseCsv('email,name\n"a@x.example","Santoso, Budi ""Bo"""\n');
    expect(result.rows).toEqual([{ email: 'a@x.example', name: 'Santoso, Budi "Bo"' }]);
  });

  it('reports rows missing email or name', () => {
    const result = parseCsv('email,name,division\na@x.example,A\n,B\n');
    expect(result.rows).toHaveLength(1);
    expect(result.malformed).toEqual([3]);
  });

  it('returns empty rows when the header lacks email or name', () => {
    const result = parseCsv('user,pass\na,b\n');
    expect(result.rows).toEqual([]);
  });
});
