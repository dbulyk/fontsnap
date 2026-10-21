# Real-shot labels

`data/realshots/labels.csv` lists photographs of type. The copy in git has the header row and no image rows. Pixel files live under `out/realshots/images/`. Git ignores `out/`.

## File format

The header row is fixed.

```
image,label,family_key,source,split
```

`image` is the file name only. A directory separator, an absolute path, or `..` is rejected.

`label` is the family name in display form, such as `Inter Tight`.

`family_key` is empty, or it is the same string `nz(label)` returns in `fontsnap_ref.pipeline`. `nz` keeps digits and lowercase letters.

`source` is empty, or one of `fontsource`, `collletttivo`, `velvetyne`, or `google_fonts`.

`split` is empty, or `real`.

Extra columns are ignored. A missing header column is an error.

## Pixel path

Each file is `out/realshots/images/` plus the `image` cell. `eval` refuses an image directory that resolves outside `out/`.

## Commands

The commands below read this file. The working directory is `python/`.

```bash
python -m train shots check --labels ../data/realshots/labels.csv
python -m train shots eval --labels ../data/realshots/labels.csv --images ../out/realshots/images --model ../model/model_fp16.onnx
python -m train shots displace --before ../out/py_realset3.json --after ../out/py_realset3_after.json
```

`check` reads the CSV and exits 0 when every row matches this format. It does not open images.

`eval` prints family top-1 and top-5 for the `bare` config and the `best` config. Those are the same two configs `python -m fontsnap_ref.evaluate` prints. Each image is opened with `fontsnap_ref.image.to_rgb`. An empty label file exits 2.

`displace` reads two JSON files written by `fontsnap_ref.evaluate`. It prints the fraction of shared images whose `best` top-1 family differs. It prints the cap `0.02` on the same line. A fraction above `0.02` does not change the exit code. The command does not update `model/`.

## Scoring

`bare` compares `nz(label)` to the ranked names and does not merge families.

`best` compares `merge_family(nz(label))` to the ranked names. That merge is `fontsnap_ref.pipeline.merge_family`, including the Noto prefix rule.

`family_key` is checked when the CSV is loaded. Scoring uses `label`.
