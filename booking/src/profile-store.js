// ============================================================
// ブラウザプロファイルの保存・復元(Cloud Storage)。
//
// 目的: 毎回まっさらなブラウザだと Google から「初見の端末」と見なされ、reCAPTCHA の画像問題が重くなる。
//       Cookie(google.com / recaptcha の信用情報)を持ち越すことで、人間が解くたびに信用が積み上がるようにする。
//
//   restoreProfile(bucket, dir, log)  GCS の profile.tar.gz を dir に展開(無ければ何もしない)
//   saveProfile(bucket, dir, log)     dir をキャッシュ類を除いて tar.gz にして GCS に上げる
//
// 環境変数 PROFILE_BUCKET が無ければ両方とも何もしない(ローカル実行など)。
// tar はコンテナ(Playwright 公式イメージ)に入っている。認証は Cloud Run のサービスアカウント(ADC)。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const OBJECT = 'profile.tar.gz';
// 保存しない(大きいだけで信用に関係ない)ディレクトリ
const EXCLUDES = ['Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 'Default/Service Worker', 'Default/DawnCache', 'GrShaderCache', 'ShaderCache', 'Default/blob_storage', 'BrowserMetrics', 'Crashpad'];

async function storage() {
  const { Storage } = await import('@google-cloud/storage');
  return new Storage();
}

export async function restoreProfile(bucket, dir, log = () => {}) {
  if (!bucket) return false;
  const started = Date.now();
  try {
    const file = (await storage()).bucket(bucket).file(OBJECT);
    const [exists] = await file.exists();
    if (!exists) {
      log('プロファイル: 保存済みのものが無いので新規に作ります');
      return false;
    }
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(path.dirname(dir), 'profile-restore.tar.gz');
    await file.download({ destination: tmp });
    await run('tar', ['-xzf', tmp, '-C', dir]);
    fs.rmSync(tmp, { force: true });
    log(`プロファイル: 復元しました (${Date.now() - started}ms)`);
    return true;
  } catch (e) {
    log(`プロファイル: 復元に失敗(無視して新規で続行): ${e.message.split('\n')[0]}`);
    return false;
  }
}

export async function saveProfile(bucket, dir, log = () => {}) {
  if (!bucket || !fs.existsSync(dir)) return false;
  const started = Date.now();
  try {
    const tmp = path.join(path.dirname(dir), 'profile-save.tar.gz');
    const args = ['-czf', tmp, ...EXCLUDES.flatMap((e) => ['--exclude', `./${e}`]), '-C', dir, '.'];
    await run('tar', args);
    const size = fs.statSync(tmp).size;
    await (await storage()).bucket(bucket).upload(tmp, { destination: OBJECT, resumable: false });
    fs.rmSync(tmp, { force: true });
    log(`プロファイル: 保存しました (${Math.round(size / 1024)}KB, ${Date.now() - started}ms)`);
    return true;
  } catch (e) {
    log(`プロファイル: 保存に失敗(無視): ${e.message.split('\n')[0]}`);
    return false;
  }
}
