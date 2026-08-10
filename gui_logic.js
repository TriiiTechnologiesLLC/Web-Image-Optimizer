const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawnSync } = require('child_process');
const util = require('util');
const sharp = require('sharp');
const ExifParser = require('exif-parser');

require('dotenv').config();

let S3Client, PutObjectCommand;
try { ({ S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')); } catch {}
let Client;
try { Client = require('ssh2-sftp-client'); } catch {}

const execFileP = util.promisify(execFile);
const fsPromises = fs.promises;

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function ensureLongPaths(p) {
    if (process.platform === 'win32' && path.isAbsolute(p) && p.length > 250 && !p.startsWith('\\\\?\\')) {
        return `\\\\?\\${p}`;
    }
    return p;
}

async function atomicWrite(filePath, buffer) {
    const tmpPath = `${filePath}.tmp.${crypto.randomBytes(8).toString('hex')}`;
    await fsPromises.writeFile(tmpPath, buffer);
    await fsPromises.rename(tmpPath, filePath);
}

async function uploadWithTimeout(uploadFn, timeoutMs = 15000) {
    return Promise.race([
        uploadFn(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Upload timed out')), timeoutMs))
    ]);
}

async function withRetries(fn, retries = 2, delayMs = 500) {
    for (let i = 0; i <= retries; i++) {
        try { return await fn(); }
        catch (err) {
            if (i === retries) throw err;
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
}

function isBinaryAvailable(name) {
    try {
        const res = spawnSync(name, ['-v'], { stdio: 'ignore', timeout: 2000 });
        return res.status === 0;
    } catch { return false; }
}

function getMimeType(ext) {
    const map = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
    return map[ext] || 'application/octet-stream';
}

function redactGpsFromExif(exifBuffer, fuzzPrecision = 0) {
    if (!exifBuffer || exifBuffer.length === 0) return null;
    try {
        const parser = ExifParser.create(exifBuffer);
        const exifData = parser.parse();

        if (!exifData || !exifData.tags) return null;

        if (fuzzPrecision > 0 && exifData.gps) {
            const round = Math.pow(10, fuzzPrecision);
            if (exifData.gps.latitude !== undefined) exifData.gps.latitude = Math.round(exifData.gps.latitude * round) / round;
            if (exifData.gps.longitude !== undefined) exifData.gps.longitude = Math.round(exifData.gps.longitude * round) / round;
        }

        Object.keys(exifData.tags).forEach(k => {
            if (k.startsWith('GPS') || k.toLowerCase().includes('gps')) {
                delete exifData.tags[k];
            }
        });

        return typeof parser.build === 'function' ? parser.build() : null;
    } catch (e) {
        return null;
    }
}

async function collectFiles(dir) {
    let files = [];
    try {
        const entries = await fsPromises.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) files = files.concat(await collectFiles(fullPath));
            else if (/\.(png|jpe?g|webp)$/i.test(entry.name)) files.push(fullPath);
        }
    } catch (err) {
        if (err.code !== 'EPERM') console.warn(`⚠️  Skipped dir: ${dir}`);
    }
    return files;
}

async function validateInput(inputPath, maxFileSize = 100 * 1024 * 1024, maxDimensions = 50 * 1000 * 1000) {
    try {
        const stats = await fsPromises.stat(inputPath);
        if (stats.size > maxFileSize) throw new Error(`File too large: ${formatBytes(stats.size)} exceeds limit of ${formatBytes(maxFileSize)}`);
        const meta = await sharp(inputPath).metadata();
        const pixels = (meta.width || 0) * (meta.height || 0);
        if (pixels > maxDimensions) throw new Error(`Image too large: ${pixels} pixels`);
        return true;
    } catch (err) {
        throw err;
    }
}

async function uploadToRemote(buffer, config, filename, opts) {
    if (!config.target) return true;
    const remotePath = (config.remotePath || '').replace(/\/+$/, '');
    const safeFilename = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
    const fullPath = `${remotePath}/${safeFilename}`.replace(/^\/+/, '');

    try {
        if (config.target === 's3') {
            if (!S3Client) throw new Error('@aws-sdk/client-s3 not installed');
            const client = new S3Client({ region: config.region });
            await uploadWithTimeout(async () => {
                await withRetries(async () => {
                    await client.send(new PutObjectCommand({
                        Bucket: config.bucket, Key: fullPath, Body: buffer, ContentType: getMimeType(path.extname(filename))
                    }));
                }, 2, 500);
            });
        } else if (config.target === 'sftp') {
            if (!Client) throw new Error('ssh2-sftp-client not installed');
            const auth = {};
            if (!opts.sftpKeyFile) throw new Error('SFTP requires SSH key');
            auth.privateKey = fs.readFileSync(opts.sftpKeyFile).toString();

            const sftp = new Client({ strictHostKeyChecking: true });
            await uploadWithTimeout(async () => {
                await withRetries(async () => {
                    await sftp.connect({ host: config.host, port: config.port || 22, ...auth });
                    const dirParts = fullPath.split('/').slice(0, -1);
                    let current = '';
                    for (const part of dirParts) {
                        current += (current ? '/' : '') + part;
                        try { await sftp.stat(current); } catch { await sftp.mkdir(current); }
                    }
                    const beforeSize = buffer.length;
                    await sftp.put(buffer, fullPath);
                    const stats = await sftp.stat(fullPath);
                    if (stats.size !== beforeSize) throw new Error(`SFTP size mismatch`);
                    await sftp.end();
                }, 2, 500);
            });
        }
        return true;
    } catch (err) {
        throw new Error(`Upload failed: ${err.message}`);
    }
}

async function compressFile(inputPath, outputBase, opts) {
    const absInput = path.resolve(ensureLongPaths(inputPath));
    try { await validateInput(absInput); }
    catch (err) { return { success: false, filename: path.basename(absInput), error: `Validation failed: ${err.message}` }; }

    const parsed = path.parse(absInput);
    const ext = parsed.ext.toLowerCase();
    const outExt = opts.toWebp ? '.webp' : ext;
    const outDir = path.join(outputBase, parsed.dir === parsed.root ? '' : parsed.dir.replace(parsed.root, ''));
    const outPath = path.resolve(ensureLongPaths(path.join(outputBase, parsed.name + outExt)));

    await fsPromises.mkdir(path.dirname(outPath), { recursive: true });
    const originalSize = (await fsPromises.stat(absInput)).size;

    if (ext === '.png' && !opts.toWebp && isBinaryAvailable('optipng')) {
        const stripFlag = opts.stripMeta ? '-strip' : '-preserve';
        try {
            await withRetries(() => execFileP('optipng', ['-o5', '-quiet', '-out', outPath, stripFlag, 'all', absInput]));
            const compressedSize = (await fsPromises.stat(outPath)).size;
            return { success: true, filename: path.basename(outPath), original: originalSize, compressed: compressedSize, reduction: ((originalSize - compressedSize) / originalSize * 100).toFixed(1), tool: 'optipng', uploadOk: false };
        } catch (err) { /* Fallback to sharp */ }
    }

    try {
        const meta = await sharp(absInput).metadata();
        let pipeline = sharp(absInput);

        if (opts.fixOrientation && (!opts.stripMeta || meta.exif)) {
            pipeline = pipeline.rotate();
        }

        let customExif = null;
        if (!opts.stripMeta && meta.exif && opts.redactGps) {
            customExif = redactGpsFromExif(meta.exif, opts.fuzzPrecision || 0);
        }

        if (!opts.stripMeta) {
            if (customExif) {
                pipeline = pipeline.withMetadata({ exif: customExif });
            } else {
                pipeline = pipeline.withMetadata();
            }
        }

        if (outExt === '.webp') {
            pipeline = pipeline.webp({ quality: 85, effort: 4 });
        } else if (outExt === '.jpg' || outExt === '.jpeg') {
            pipeline = pipeline.jpeg({ quality: 85, mozjpeg: true });
        } else {
            pipeline = pipeline.png({ compressionLevel: 8 });
        }

        const buffer = await withRetries(() => pipeline.toBuffer());
        await atomicWrite(outPath, buffer);

        let uploadOk = false;
        if (opts.uploadTo) {
            try {
                const targetConfig = opts.uploadTo === 's3'
                    ? { target: 's3', bucket: opts.s3Bucket, region: opts.s3Region }
                    : { target: 'sftp', host: opts.sftpHost, port: opts.sftpPort };
                await uploadWithTimeout(() => uploadToRemote(buffer, targetConfig, path.basename(outPath), opts));
                uploadOk = true;
            } catch (uErr) { console.warn(`⚠️  Upload failed: ${uErr.message}`); }
        }

        return { success: true, filename: path.basename(outPath), original: originalSize, compressed: buffer.length, reduction: ((originalSize - buffer.length) / originalSize * 100).toFixed(1), tool: 'sharp', converted: outExt !== ext, uploadOk };
    } catch (err) {
        return { success: false, filename: path.basename(absInput), error: `sharp processing failed: ${err.message}` };
    }
}

// ─── Icon Kit Generation ──────────────────────────────────────────────

const ICON_CONFIG = [
    { name: 'favicon-16x16', size: 16, type: 'png' },
    { name: 'favicon-32x32', size: 32, type: 'png' },
    { name: 'apple-touch-icon', size: 180, type: 'png' },
    { name: 'android-chrome-192x192', size: 192, type: 'png' },
    { name: 'android-chrome-512x512', size: 512, type: 'png' },
];

async function iconKitGeneration(sourceImagePath, outputBase) {
    const absSource = path.resolve(ensureLongPaths(sourceImagePath));

    if (!(await fsPromises.access(absSource).then(() => true).catch(() => false))) {
        throw new Error(`Source image not found: ${absSource}`);
    }

    const iconKitDir = path.resolve(path.join(outputBase, 'icon-kit'));
    await fsPromises.mkdir(iconKitDir, { recursive: true });

    const metadata = await sharp(absSource).metadata();
    const width = metadata.width;
    const height = metadata.height;

    let cropParams = {};
    if (width !== height) {
        const size = Math.min(width, height);
        const x = Math.floor((width - size) / 2);
        const y = Math.floor((height - size) / 2);
        cropParams = { left: x, top: y, width: size, height: size };
    }

    const results = [];

    for (const icon of ICON_CONFIG) {
        const outputFile = path.join(iconKitDir, `${icon.name}.${icon.type}`);

        await sharp(absSource)
            .extract(cropParams)
            .resize(icon.size, icon.size, { fit: 'cover', position: 'center' })
            .png()
            .toFile(outputFile);

        const stat = await fsPromises.stat(outputFile);
        results.push({ name: `${icon.name}.${icon.type}`, size: icon.size, bytes: stat.size });
    }

    return {
        directory: iconKitDir,
        files: results.map(r => r.name),
        fileCount: results.length,
        totalBytes: results.reduce((acc, r) => acc + r.bytes, 0),
    };
}

// ─── Batch Pipeline ───────────────────────────────────────────────────

async function processBatch(inputPath, outputBase, opts) {
    const start = Date.now();
    const resolvedInput = path.resolve(inputPath);
    const isDir = fs.statSync(resolvedInput).isDirectory();
    const files = isDir ? await collectFiles(resolvedInput) : [resolvedInput];

    if (inputPath === outputBase) return { log: '!!! Input PATH is same as Output PATH. ABORT !!!', success: 0, failures: 0 };

    if (files.length === 0) return { log: '📭 No supported images found.', success: 0, failures: 0 };

    let successCount = 0, failCount = 0;
    let logs = [];

    for (let file of files) {
        let res = await compressFile(file, path.resolve(outputBase), opts);

        if (res.success) {
            successCount++;
            logs.push(`✓ ${res.filename} Original Size: ${formatBytes(res.original)} New Size: ${formatBytes(res.compressed)} (-${res.reduction}% via ${res.tool})`);
        } else {
            failCount++;
            logs.push(`✗ ${path.basename(file)}: ${res.error}`);
        }
    }

    return {
        log: `✅ Pipeline Complete in ${((Date.now() - start) / 1000).toFixed(2)}s\n\n${logs.join('\n')}`,
        success: successCount, failures: failCount || 0,
        failed: failCount || 0
    };
}

module.exports = { processBatch, formatBytes, compressFile, iconKitGeneration };