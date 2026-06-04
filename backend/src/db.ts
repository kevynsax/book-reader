import mongoose from 'mongoose';
import { MONGODB_URI } from './config.js';

export async function connectDb() {
  await mongoose.connect(MONGODB_URI);
  console.log('MongoDB connected');
}
