import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

export async function getPdfPageCount(pdfPath: string): Promise<number> {
  try {
    const { stdout } = await execAsync(`pdfinfo "${pdfPath}"`);
    const match = stdout.match(/Pages:\s+(\d+)/);
    return match ? parseInt(match[1]) : 0;
  } catch {
    throw new Error('pdfinfo not found. Install poppler: brew install poppler');
  }
}

export async function splitPdfIntoPages(pdfPath: string, outputDir: string): Promise<number> {
  const partsDir = path.join(outputDir, 'parts');
  await fs.mkdir(partsDir, { recursive: true });

  const numPages = await getPdfPageCount(pdfPath);

  try {
    await execFileAsync('pdftoppm', [
      '-jpeg',
      '-r', '150',
      '-jpegopt', 'quality=85',
      pdfPath,
      path.join(partsDir, 'page'),
    ]);
  } catch {
    throw new Error('pdftoppm not found. Install poppler: brew install poppler');
  }

  return numPages;
}

export function getPageImagePath(outputDir: string, pageNum: number, totalPages: number): string {
  const digits = Math.max(totalPages.toString().length, 1);
  const paddedNum = String(pageNum).padStart(digits, '0');
  return path.join(outputDir, 'parts', `page-${paddedNum}.jpg`);
}

export async function findPageImagePath(outputDir: string, pageNum: number): Promise<string | null> {
  const partsDir = path.join(outputDir, 'parts');
  try {
    const files = await fs.readdir(partsDir);
    const sorted = files.filter(f => f.startsWith('page-') && f.endsWith('.jpg')).sort();
    const target = sorted[pageNum - 1];
    if (!target) return null;
    return path.join(partsDir, target);
  } catch {
    return null;
  }
}

export async function getAllPagePaths(outputDir: string): Promise<string[]> {
  const partsDir = path.join(outputDir, 'parts');
  const files = await fs.readdir(partsDir);
  return files
    .filter(f => f.startsWith('page-') && f.endsWith('.jpg'))
    .sort()
    .map(f => path.join(partsDir, f));
}

export async function readPageAsBase64(imagePath: string): Promise<string> {
  const buffer = await fs.readFile(imagePath);
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

export async function copyPageAsCover(imagePath: string, coverPath: string): Promise<void> {
  await fs.copyFile(imagePath, coverPath);
}
