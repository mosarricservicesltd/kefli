// Ciphertext waiting for upload: Paths.document/shelf/staging/<sha256>.bin (mobile spec 4.2), kept until the
// operator holds the blob.
import { Directory, File, Paths } from 'expo-file-system';

const dir = () => new Directory(Paths.document, 'shelf', 'staging');

export function stageBlob(sha256: string, bytes: Uint8Array): string {
  const d = dir();
  if (!d.exists) d.create({ intermediates: true });
  const f = new File(d, `${sha256}.bin`);
  f.write(bytes);
  return f.uri;
}

export async function readStaged(sha256: string): Promise<Uint8Array | null> {
  const f = new File(dir(), `${sha256}.bin`);
  return f.exists ? f.bytes() : null;
}
