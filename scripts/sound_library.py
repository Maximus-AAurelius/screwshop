"""Local SPLITZ folders and conservative, playable excerpts from separated stems."""
import json
import shutil
import uuid
from pathlib import Path
import numpy as np
import soundfile as sf
from studio_exports import slug


def sample_candidates(source, dest, kind):
    audio, rate = sf.read(source, dtype='float32', always_2d=True)
    # Ten-millisecond energy windows; peaks are auditionable candidates, not isolated instruments.
    hop = max(1, rate // 100)
    if len(audio) < hop * 3:
        return []
    mono = np.mean(audio * audio, axis=1)
    energy = np.sqrt(np.mean(mono[:len(mono)//hop*hop].reshape(-1, hop), axis=1))
    peak = float(energy.max())
    if peak < 0.0005:
        return []
    onset = np.maximum(0, energy - np.concatenate(([0], energy[:-1])))
    candidates = np.argsort(onset)[::-1]
    chosen, output, fingerprints = [], [], []
    count = 6 if kind == 'drums' else 1
    duration = 0.65 if kind == 'drums' else 2.0
    for frame in candidates[:400]:
        if onset[frame] < peak * 0.04 or energy[frame] < peak * 0.12:
            continue
        start = max(0, int(frame) * hop - int(rate * 0.012))
        if any(abs(start - old) < rate * duration for old in chosen):
            continue
        end = min(len(audio), start + int(rate * duration))
        following = np.flatnonzero(onset[int(frame)+8:] > max(peak * .08, onset[frame] * .3))
        if len(following):
            end = min(end, (int(frame) + 8 + int(following[0])) * hop)

        clip = audio[start:end].copy()
        if len(clip) < rate * 0.06:
            continue
        # Keep one example of a timbre, not every repetition at another volume.
        spectrum = np.abs(np.fft.rfft(clip.mean(axis=1), n=32768))
        edges = np.geomspace(1, len(spectrum), 25).astype(int)
        fingerprint = np.array([np.linalg.norm(spectrum[a:max(a+1,b)]) for a,b in zip(edges[:-1],edges[1:])])
        fingerprint /= max(float(np.linalg.norm(fingerprint)), 1e-10)
        if any(float(np.dot(fingerprint, old)) > 0.93 for old in fingerprints):
            continue
        fingerprints.append(fingerprint)
        # Keep tails within the candidate window; short edge fades prevent clicks.
        fade = min(int(rate * 0.004), len(clip)//4)
        clip[:fade] *= np.linspace(0, 1, fade)[:, None]
        clip[-fade:] *= np.linspace(1, 0, fade)[:, None]
        name = f'{kind}-{"hit" if kind == "drums" else "phrase"}-{len(output)+1:02d}'
        path = dest / (name + '.wav'); path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(path, clip, rate, subtype='PCM_16')
        output.append({'name': name, 'kind': kind, 'sample': True, 'source_start': start/rate, 'duration': len(clip)/rate,
                       'note': 'Extracted candidate; may contain overlapping sounds.', 'path': path})
        chosen.append(start)
        if len(output) >= count:
            break
    return output


def index_split(store, job):
    beat = store.query({'table':'beats','filters':[['id',job['beat_id']]],'single':'required'})
    name = str(beat.get('label') or 'Song')
    base = f'SPLITZ/{slug(name)}-{job["id"]}'
    kinds = ['vocals','instrumental'] if job['mode']=='quick' else ['vocals','instrumental','drums','bass','guitar','piano','other']
    files = []
    for kind in kinds:
        source = store.asset('stems', f'local/{job["beat_id"]}/{job["id"]}/{kind}.wav')
        relative = f'{base}/{kind}.wav'; dest = store.asset('stems',relative)
        dest.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(source,dest)
        files.append({'name':kind,'kind':kind,'bucket':'stems','storage_path':relative,'sample':False})
        if job['mode']=='full' and kind not in ('vocals','instrumental'):
            for item in sample_candidates(source,dest.parent/'Samples',kind):
                path = item.pop('path')
                files.append({**item,'bucket':'stems','storage_path':str(path.relative_to(store.root/'audio'/'stems')).replace('\\','/')})
    record = {'id':'split-folder-'+job['id'],'folder_type':'split','name':name,'mode':job['mode'],'job_id':job['id'],'beat_id':job['beat_id'],'files':files}
    (dest.parent/'manifest.json').write_text(json.dumps(record,indent=2),encoding='utf-8')
    return store.query({'table':'settings','action':'upsert','values':record,'single':'required'})


def save_library_pack(store, folder_id, name):
    if not isinstance(name,str) or not name.strip() or len(name)>100:
        raise ValueError('Enter a pack name (1-100 characters)')
    folder = store.query({'table':'settings','filters':[['id',folder_id]],'single':'required'})
    if folder.get('folder_type')!='split':
        raise ValueError('Choose a completed SPLITZ folder')
    pack_id = str(uuid.uuid4()); base = f'Packs/{slug(name)}-{pack_id}'
    files=[]
    for i, item in enumerate(folder.get('files',[])):
        source=store.asset(item['bucket'],item['storage_path'])
        relative=f'{base}/{i:02d}-{slug(item["name"])}.wav'; dest=store.asset('stems',relative)
        dest.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(source,dest)
        files.append({**item,'bucket':'stems','storage_path':relative})
    record={'id':'sound-pack-'+pack_id,'folder_type':'pack','name':name.strip(),'files':files,'source_folder':folder_id}
    if files:
        (dest.parent/'manifest.json').write_text(json.dumps(record,indent=2),encoding='utf-8')
    return store.query({'table':'settings','action':'upsert','values':record,'single':'required'})
