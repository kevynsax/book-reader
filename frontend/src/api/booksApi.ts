import axios from 'axios';

export const api = axios.create({ baseURL: '' });

export async function uploadBook(formData: FormData): Promise<{ bookId: string }> {
  const res = await api.post<{ bookId: string }>('/api/books', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}
