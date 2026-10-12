"""Isolated Demucs inference using SoundFile I/O and the current CPU PyTorch runtime."""
import argparse
from pathlib import Path
import numpy as np
import soundfile as sf
import torch
from demucs.pretrained import get_model
from demucs.apply import apply_model


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', choices=['htdemucs', 'htdemucs_6s'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    # --all: write every model source as float WAV with no rescaling, so the stems still sum to the song (engineer mix).
    parser.add_argument('--all', action='store_true')
    parser.add_argument('source', type=Path)
    args = parser.parse_args()
    torch.set_num_threads(2)
    model = get_model(args.model)
    model.eval()
    audio, rate = sf.read(args.source, dtype='float32', always_2d=True)
    if rate != model.samplerate or audio.shape[1] != model.audio_channels:
        raise ValueError('Input must be decoded at the model sample rate and channel count')
    wav = torch.from_numpy(audio.T.copy())
    reference = wav.mean(0)
    mean, std = reference.mean(), reference.std()
    if not torch.isfinite(std) or std < 1e-8:
        sources = torch.zeros((len(model.sources), *wav.shape))
    else:
        with torch.inference_mode():
            sources = apply_model(model, ((wav - mean) / std)[None], device='cpu', shifts=1, split=True, overlap=0.25, progress=True, num_workers=1)[0]
            sources = sources * std + mean
    output = args.output / args.model / args.source.stem
    output.mkdir(parents=True, exist_ok=True)
    pairs = list(zip(model.sources, sources))
    if args.all:
        for name, source in pairs:
            array = source.cpu().numpy().T
            if not np.all(np.isfinite(array)):
                raise ValueError('Model produced invalid audio')
            sf.write(output / (name + '.wav'), array, rate, subtype='FLOAT')
        return
    if args.model == 'htdemucs':
        vocals = sources[model.sources.index('vocals')]
        instrumental = sum(source for name, source in pairs if name != 'vocals')
        pairs = [('vocals', vocals), ('no_vocals', instrumental)]
    for name, source in pairs:
        array = source.cpu().numpy().T
        if not np.all(np.isfinite(array)):
            raise ValueError('Model produced invalid audio')
        array = array / max(1.0, float(np.max(np.abs(array))))
        sf.write(output / (name + '.wav'), array, rate, subtype='PCM_16')


if __name__ == '__main__':
    main()
