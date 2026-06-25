import mongoose from 'mongoose';
import { connectDb } from '../db.js';
import { Book } from '../models/Book.js';

// One-off: clear any audio rendering left mid-flight in the database (e.g. from a
// job that was interrupted by a crash/restart, so the in-memory stop registry
// never saw it). Mirrors the worker's finalizeStop: generating tracks become
// 'stale', generating segments revert to 'pending', and books stuck in
// 'generating_audio' go back to 'complete' so finished chapters stay playable
// and the rest can be resumed with Generate.
async function main() {
  await connectDb();

  const books = await Book.find({});
  let touchedBooks = 0;
  let tracks = 0;
  let segments = 0;

  for (const book of books) {
    let changed = false;

    for (const chapter of book.chapters) {
      for (const track of chapter.tracks) {
        if (track.audioStatus === 'generating') {
          track.audioStatus = 'stale';
          tracks++;
          changed = true;
        }
        for (const seg of track.segments) {
          if (seg.audioStatus === 'generating') {
            seg.audioStatus = 'pending';
            segments++;
            changed = true;
          }
        }
      }
    }

    if (book.status === 'generating_audio') {
      book.status = 'complete';
      book.progress = {
        current: book.progress?.current ?? 0,
        total: book.progress?.total ?? 0,
        message: 'Stopped.',
      };
      changed = true;
    }

    if (changed) {
      await book.save();
      touchedBooks++;
      console.log(`stopped rendering: ${book.name || book._id}`);
    }
  }

  console.log(`\nDone. ${touchedBooks} book(s) updated — ${tracks} track(s) and ${segments} segment(s) cleared.`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
