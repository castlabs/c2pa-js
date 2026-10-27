"""CI-only generic BMFF exclusion fixtures; no VSI producer or native build.

Usage: python tools/bmff-exclusion-fixtures.py PYTHON_REFERENCE SDK_REFERENCE OUT
OUT must be empty. Recipes, offsets and mutations are deterministic; native
assertion salts and ES256 signatures are not promised byte-for-byte repeatable.
Every browser expectation is checked against the installed published wheel.
Required success codes are checked as a subset; failure sets must be exact,
except descriptor tampering permits an additional BMFF mismatch. Init-side
controls reuse each of the three original UUID-cut leaves at its signed offset.
"""

import base64
import hashlib
import importlib.metadata
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import traceback
import uuid

import c2pa
import c2pa.c2pa as bindings


PYTHON_VERSION = "0.37.13+signer.1.0.9"
PYTHON_SHA = "98ccd6de63d89eca9c23f27658f6b29fe99daffc"
SDK_SHA = "6021100cc5060b06061ca15b634281cfeb97c718"
NATIVE_SHA256 = "d356a7afe705381d3a4f7d2f7fbdb70aab2325ad7617cefd29d035a301ff7c99"
SIDX_SOURCE_SHA256 = "8d95ae1959740b8fd02d30ad9e4eb04da7dc26869c14605677c084ce9b03ccff"
MATCH = "assertion.bmffHash.match"
MISMATCH = "assertion.bmffHash.mismatch"
ASSERTION_MISMATCH = "assertion.hashedURI.mismatch"
C2PA_UUID = bytes.fromhex("d8fec3d61b0e483c92975828877ec481")


def require(condition, message):
    # Do not let python -O disable qualification checks.
    if not condition:
        raise RuntimeError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def revision(root):
    return subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
    ).strip()


def boxes(data, start=0, end=None):
    """Parse bounded root/JUMBF boxes, including extended and terminal sizes."""
    end = len(data) if end is None else end
    result = []
    offset = start
    while offset < end:
        require(end - offset >= 8, f"truncated box header at {offset}")
        size = int.from_bytes(data[offset:offset + 4], "big")
        header = 8
        if size == 1:
            require(end - offset >= 16, f"truncated extended box at {offset}")
            size = int.from_bytes(data[offset + 8:offset + 16], "big")
            header = 16
        elif size == 0:
            size = end - offset
        require(header <= size <= end - offset, f"invalid box size at {offset}")
        result.append({"type": data[offset + 4:offset + 8].decode("latin1"),
                       "offset": offset, "bytes": size, "headerBytes": header,
                       "payloadOffset": offset + header, "end": offset + size})
        offset += size
    return result


def of_type(data, kind):
    return [box for box in boxes(data) if box["type"] == kind]


def box(kind, payload):
    return (len(payload) + 8).to_bytes(4, "big") + kind.encode("ascii") + payload


def canonical_exclusion(entry):
    """Normalize only descriptor byte fields, not other strings or scalars.

    Settings accept integer arrays. Native 602 Assertion::as_json_object uses
    CBOR byte strings, then Reader JSON formatting/hash_to_b64 emits plain base64 strings.
    Retain the raw Reader report separately so this comparison cannot hide it.
    """
    def octets(value):
        if isinstance(value, str):
            return list(base64.b64decode(value, validate=True))
        require(isinstance(value, list)
                and all(type(byte) is int and 0 <= byte <= 255 for byte in value),
                f"invalid exclusion byte representation: {value!r}")
        return list(value)

    result = dict(entry)
    if "flags" in result:
        result["flags"] = octets(result["flags"])
        require(len(result["flags"]) == 3, "exclusion flags must contain three bytes")
    if "data" in result:
        result["data"] = [{**item, "value": octets(item["value"])} for item in result["data"]]
    return result


def settings(exclusions):
    return {
        "builder": {"thumbnail": {"enabled": False},
                    "bmff_hash_extra_exclusions": exclusions},
        "verify": {"verify_after_reading": True, "verify_after_sign": True,
                   "verify_trust": False, "ocsp_fetch": False,
                   "remote_manifest_fetch": False},
    }


def expectation(valid=True, assertion_tamper=False):
    if assertion_tamper:
        return {"state": "Invalid", "success": [],
                "failure": [ASSERTION_MISMATCH], "absentFailure": []}
    return {"state": "Valid" if valid else "Invalid",
            "success": [MATCH] if valid else [],
            "failure": [] if valid else [MISMATCH],
            "absentFailure": [MISMATCH, ASSERTION_MISMATCH] if valid
            else [ASSERTION_MISMATCH]}


class Fixtures:
    def __init__(self, python_root, sdk_root, out):
        self.python_root, self.sdk_root, self.out = python_root, sdk_root, out
        require(not out.exists() or (out.is_dir() and not any(out.iterdir())),
                "output directory must be absent or empty; nothing is overwritten")
        self.inputs = {}
        self.files, self.cases, self.layouts, self.recipes = {}, [], {}, {}
        self.verdicts, self.errors = [], []
        self.generation_failure = None
        self.producer = {"expectedPythonVersion": PYTHON_VERSION,
                         "expectedPythonSourceSha": PYTHON_SHA,
                         "sdkSha": SDK_SHA, "expectedNativeLibrarySha256": NATIVE_SHA256,
                         "generatorSha256": sha256(Path(__file__).read_bytes()),
                         "signingApi": "Builder.sign", "algorithm": "es256", "tsa": None,
                         "verifyTrust": False}
        out.mkdir(parents=True, exist_ok=True)

    def prepare(self):
        self.producer["pythonVersion"] = importlib.metadata.version("c2pa-python")
        require(self.producer["pythonVersion"] == PYTHON_VERSION,
                f"requires installed c2pa-python {PYTHON_VERSION}")
        self.producer["pythonSourceSha"] = revision(self.python_root)
        require(self.producer["pythonSourceSha"] == PYTHON_SHA, "Python reference is not pinned published source")
        self.producer["sdkReferenceSha"] = revision(self.sdk_root)
        require(self.producer["sdkReferenceSha"] == SDK_SHA, "SDK reference is not pinned native 602")
        native_path = Path(bindings._lib._name).resolve()
        self.producer["nativeLibrarySha256"] = sha256(native_path.read_bytes())
        require(self.producer["nativeLibrarySha256"] == NATIVE_SHA256,
                "loaded native library bytes differ from the published Linux wheel")
        wrapper = self.input("python", "src/c2pa/c2pa.py")
        installed_wrapper = Path(bindings.__file__).read_bytes()
        self.producer["pythonBindingSha256"] = sha256(installed_wrapper)
        require(installed_wrapper == wrapper, "installed Python binding differs from pinned source bytes")
        self.producer.update({"sdkVersion": c2pa.sdk_version(), "nativeVersion": bindings.version()})
        require(self.producer["sdkVersion"] == "0.92.0-dev", "requires native 0.92.0-dev")
        lock_bytes = self.input("python", "release/castlabs-vsi-inputs.lock.json")
        self.producer["pythonReleaseLockSha256"] = sha256(lock_bytes)
        lock = json.loads(lock_bytes)
        require(lock["package"]["version"] == PYTHON_VERSION, "wrong Python source lock")
        require(lock["rustSource"]["commit"] == SDK_SHA, "wrong locked native SHA")
        require(c2pa.has_fragment_at_offset(), "offset-aware Reader capability required")
        self.certs = self.input("python", "tests/fixtures/es256_certs.pem")
        self.key = self.input("python", "tests/fixtures/es256_private.key")

    def input(self, repository, relative):
        root = self.python_root if repository == "python" else self.sdk_root
        data = (root / relative).read_bytes()
        commit = PYTHON_SHA if repository == "python" else SDK_SHA
        committed = subprocess.check_output(["git", "-C", str(root), "show", f"{commit}:{relative}"])
        require(data == committed, f"reference bytes differ from pinned commit: {repository}:{relative}")
        self.inputs[f"{repository}:{relative}"] = {"sha256": sha256(data), "bytes": len(data)}
        return data

    def write(self, name, data, layout=False):
        path = PurePosixPath(name)
        require(not path.is_absolute() and ".." not in path.parts
                and str(path) == name and "\\" not in name,
                f"unsafe relative output path: {name}")
        require(name not in self.files, f"duplicate output: {name}")
        target = self.out.joinpath(*path.parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as output:
            output.write(data)
        self.files[name] = {"sha256": sha256(data), "bytes": len(data)}
        if layout:
            self.layouts[name] = boxes(data)
        return name

    def sign(self, name, source, exclusions):
        identity = str(uuid.uuid5(uuid.NAMESPACE_URL, "urn:bmff-exclusion-fixture:" + name))
        definition = {
            "claim_version": 2, "format": "video/mp4", "title": name,
            "instance_id": "xmp:iid:" + identity,
            "claim_generator_info": [{"name": "BMFF exclusion qualification", "version": "1"}],
            "assertions": [{"label": "c2pa.actions", "data": {"actions": [{
                "action": "c2pa.created", "when": "2026-09-10T12:00:00Z",
                "digitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation",
            }]}}],
        }
        config = settings(exclusions)
        destination = io.BytesIO()
        with c2pa.Context.from_dict(config) as context, c2pa.Signer.from_info(
            c2pa.C2paSignerInfo(alg=b"es256", sign_cert=self.certs,
                                private_key=self.key, ta_url=None)
        ) as signer, c2pa.Builder(definition, context=context) as builder:
            builder.sign(signer, "video/mp4", io.BytesIO(source), destination)
        data = destination.getvalue()
        filename = self.write(name + "/clean.mp4", data, layout=True)
        self.recipes[name] = {"file": filename, "settings": config,
                              "manifestDefinition": definition,
                              "unsignedInput": {"sha256": sha256(source), "bytes": len(source)}}
        with c2pa.Context.from_dict(settings([])) as context, c2pa.Reader(
            "video/mp4", io.BytesIO(data), context=context
        ) as reader:
            # Ordinary Manifest::from_store deliberately omits hard bindings.
            # The detailed report maps assertion labels directly to their data,
            # not to the {label, data} wrappers used in ordinary manifest JSON.
            detailed = json.loads(reader.detailed_json())
            require(isinstance(detailed, dict), f"{name}: invalid detailed report")
            active_label = detailed.get("active_manifest")
            manifests = detailed.get("manifests")
            require(isinstance(active_label, str) and isinstance(manifests, dict)
                    and active_label in manifests,
                    f"{name}: detailed report did not identify its active manifest")
            active = manifests[active_label]
            require(isinstance(active, dict), f"{name}: invalid detailed active manifest")
            assertion_store = active.get("assertion_store")
            require(isinstance(assertion_store, dict), f"{name}: missing detailed assertion_store")
            hashes = [{"label": label, "data": value} for label, value in assertion_store.items()
                      if label == "c2pa.hash.bmff" or label.startswith("c2pa.hash.bmff.")]
            require(len(hashes) == 1, f"{name}: expected exactly one BMFF assertion")
            descriptor = hashes[0]["data"]
            require(isinstance(descriptor, dict) and isinstance(descriptor.get("exclusions"), list),
                    f"{name}: invalid detailed BMFF assertion data")
            self.recipes[name]["activeManifest"] = active_label
            self.recipes[name]["bmffAssertion"] = hashes[0]
            canonical = [canonical_exclusion(entry) for entry in descriptor["exclusions"]]
            for entry in exclusions:
                require(canonical_exclusion(entry) in canonical,
                        f"{name}: descriptor did not round-trip: {entry}")
            self.recipes[name]["canonicalExclusions"] = canonical
        self.whole(name + "-clean", filename)
        return filename, data

    def mutate(self, name, source_file, data, changes):
        changed = bytearray(data)
        records = []
        for offset, reason in changes:
            require(0 <= offset < len(data), f"mutation outside {source_file}")
            before = changed[offset]
            changed[offset] ^= 1
            records.append({"file": name, "offset": offset, "before": before,
                            "after": changed[offset], "reason": reason})
        self.write(name, bytes(changed))
        self.recipes.setdefault("mutationSources", {})[name] = source_file
        return name, records

    def case(self, case):
        require(not any(old["name"] == case["name"] for old in self.cases), "duplicate case name")
        self.cases.append(case)
        actual = {"name": case["name"], "mode": case["mode"]}
        try:
            with c2pa.Context.from_dict(settings([])) as context:
                if case["mode"] == "whole":
                    reader = c2pa.Reader("video/mp4", io.BytesIO(
                        (self.out / case["file"]).read_bytes()), context=context)
                    actual["nativeApi"] = "Reader"
                else:
                    init = (self.out / case["init"]).read_bytes()
                    fragment = (self.out / case["fragment"]).read_bytes()
                    if "fragmentBaseOffset" in case:
                        reader = c2pa.Reader.from_fragment_at_offset(
                            "video/mp4", io.BytesIO(init), io.BytesIO(fragment),
                            case["fragmentBaseOffset"], context=context)
                        actual["nativeApi"] = "Reader.from_fragment_at_offset"
                    else:
                        # with_fragment reloads the store and creates a fresh validation log.
                        reader = c2pa.Reader("video/mp4", io.BytesIO(init), context=context)
                        try:
                            reader.with_fragment("video/mp4", io.BytesIO(init), io.BytesIO(fragment))
                        except BaseException:
                            reader.close()
                            raise
                        actual["nativeApi"] = "Reader.with_fragment (no offset)"
                with reader:
                    results = reader.get_validation_results() or {}
                    active = results.get("activeManifest") or {}
                    actual.update({"state": reader.get_validation_state(),
                                   "success": sorted({s["code"] for s in active.get("success", [])}),
                                   "failure": sorted({s["code"] for s in active.get("failure", [])}),
                                   "validationResults": results})
            expected = case["expect"]
            differences = []
            if actual["state"] != expected["state"]:
                differences.append(f"state {actual['state']} != {expected['state']}")
            for kind in ("success", "failure"):
                missing = set(expected[kind]) - set(actual[kind])
                if missing:
                    differences.append(f"missing {kind}: {sorted(missing)}")
            allowed_failures = set(expected["failure"])
            if ASSERTION_MISMATCH in allowed_failures:
                # The altered descriptor can also change the asset hard binding;
                # neither path permits unrelated signature/credential failures.
                allowed_failures.add(MISMATCH)
            unexpected = set(actual["failure"]) - allowed_failures
            if unexpected:
                differences.append(f"unexpected failure: {sorted(unexpected)}")
            forbidden = set(expected["absentFailure"]) & set(actual["failure"])
            if forbidden:
                differences.append(f"forbidden failure: {sorted(forbidden)}")
            actual["qualified"] = not differences
            if differences:
                actual["differences"] = differences
                self.errors.append(case["name"] + ": " + "; ".join(differences))
        except Exception as error:
            actual.update({"qualified": False, "exception": f"{type(error).__name__}: {error}"})
            self.errors.append(case["name"] + ": " + actual["exception"])
        self.verdicts.append(actual)

    def whole(self, name, filename, valid=True, mutations=None, assertion_tamper=False):
        case = {"name": name, "mode": "whole", "file": filename,
                "expect": expectation(valid, assertion_tamper)}
        if mutations:
            case["mutations"] = mutations
        self.case(case)

    def fragment(self, name, init, fragment, offset, valid=True, mutations=None):
        case = {"name": name, "mode": "fragment", "init": init, "fragment": fragment,
                "expect": expectation(valid)}
        if offset is not None:
            case["fragmentBaseOffset"] = offset
        if mutations:
            case["mutations"] = mutations
        self.case(case)

    def flat(self):
        source = self.input("sdk", "sdk/tests/fixtures/video1_no_manifest.mp4")
        require(not of_type(source, "moof"), "flat source must not be fragmented")
        original_layout = boxes(source)
        require(not any(of_type(source, kind) for kind in ("tst1", "tst2", "mfhd")),
                "flat source already contains synthetic fixture box types")
        last = original_layout[-1]
        if source[last["offset"]:last["offset"] + 4] == b"\0\0\0\0":
            # An EOF-sized mdat would otherwise consume our appended boxes.
            # Updating its existing four-byte size preserves every sample offset.
            require(last["bytes"] < 2**32, "cannot normalize oversized terminal box")
            at = last["offset"]
            source = source[:at] + last["bytes"].to_bytes(4, "big") + source[at + 4:]
            self.recipes["flatSourcePreparation"] = {"terminalSizeNormalizedAt": at,
                                                      "boxBytes": last["bytes"]}
        # Appending root boxes does not move the movie's existing sample offsets.
        source += (box("tst1", b"MATCH001" + bytes(range(24)))
                   + box("tst1", b"OTHER002" + bytes(range(24)))
                   + box("tst1", b"OTHER003" + bytes(range(32)))
                   + box("tst2", b"COVERED!" + bytes(range(24)))
                   # Exact mfhd field lengths: version/flags + sequence_number.
                   # Root placement and nonzero flags are synthetic resolver probes.
                   + box("mfhd", bytes([0, 0, 0, 5]) + (1).to_bytes(4, "big")))
        rules = [
            ("xpath", [{"xpath": "/tst1"}],
             [("first", "tst1", 0, 24), ("second", "tst1", 1, 24), ("third", "tst1", 2, 24)],
             [("adjacent-root", "tst2", 0, 24)]),
            ("length", [{"xpath": "/tst1", "length": 40}],
             [("first", "tst1", 0, 24), ("second", "tst1", 1, 24)],
             [("nonmatching-length", "tst1", 2, 24), ("adjacent-root", "tst2", 0, 24)]),
            ("subset", [{"xpath": "/tst1", "subset": [{"offset": 16, "length": 4}]}],
             [("start", "tst1", 0, 16), ("last", "tst1", 0, 19), ("other-instance", "tst1", 1, 16)],
             [("before", "tst1", 0, 15), ("after", "tst1", 0, 20)]),
            ("subset-to-end", [{"xpath": "/tst1", "subset": [{"offset": 24, "length": 0}]}],
             [("start", "tst1", 0, 24), ("end", "tst1", 0, 39), ("long-instance-end", "tst1", 2, 47)],
             [("before", "tst1", 0, 23), ("adjacent-root", "tst2", 0, 8)]),
            ("disjoint-subsets", [{"xpath": "/tst1", "subset": [
                {"offset": 16, "length": 2}, {"offset": 22, "length": 2}]}],
             [("first-range", "tst1", 0, 16), ("second-range", "tst1", 0, 22)],
             [("gap", "tst1", 0, 20), ("after", "tst1", 0, 24)]),
            ("data-predicate", [{"xpath": "/tst1", "data": [
                {"offset": 8, "value": list(b"MATCH001")}, {"offset": 16, "value": [0, 1]}],
                "subset": [{"offset": 24, "length": 4}]}],
             [("matched", "tst1", 0, 24)],
             [("nonmatched-instance", "tst1", 1, 24), ("predicate-changed", "tst1", 0, 8),
              ("second-predicate-changed", "tst1", 0, 16), ("before-subset", "tst1", 0, 23),
              ("after-subset", "tst1", 0, 28)]),
        ]
        for name, predicate in [
            ("fullbox-exact", {"version": 0, "flags": [0, 0, 5], "exact": True}),
            ("fullbox-mask", {"version": 0, "flags": [0, 0, 1], "exact": False}),
        ]:
            rules.append((name, [{"xpath": "/mfhd", **predicate,
                                  "subset": [{"offset": 13, "length": 2}]}],
                          [("payload", "mfhd", 0, 13)],
                          [("before", "mfhd", 0, 12), ("after", "mfhd", 0, 15),
                           ("version-changed", "mfhd", 0, 8), ("flags-changed", "mfhd", 0, 11)]))
        for name, rule in [
            ("length-nonmatch", {"xpath": "/tst1", "length": 41}),
            ("version-nonmatch", {"xpath": "/mfhd", "version": 1}),
            ("flags-exact-nonmatch", {"xpath": "/mfhd", "flags": [0, 0, 1], "exact": True}),
            ("flags-mask-nonmatch", {"xpath": "/mfhd", "flags": [0, 0, 2], "exact": False}),
        ]:
            kind = "tst1" if name.startswith("length") else "mfhd"
            rules.append((name, [rule], [], [("covered", kind, 0, 24 if kind == "tst1" else 13)]))
        rules.insert(0, ("default-control", [], [], [("covered-custom", "tst1", 0, 24)]))
        for name, exclusions, excluded, included in rules:
            filename, signed = self.sign("flat-" + name, source, exclusions)
            for valid, mutations in [(True, excluded), (False, included)]:
                for suffix, kind, instance, relative in mutations:
                    target = of_type(signed, kind)[instance]
                    require(relative < target["bytes"], "box-relative mutation out of bounds")
                    label = f"flat-{name}-{suffix}"
                    path, records = self.mutate(label + ".mp4", filename, signed, [(
                        target["offset"] + relative,
                        f"{'excluded' if valid else 'included'} /{kind}[{instance}] box-relative byte {relative}")])
                    self.whole(label, path, valid, records)
            if name == "data-predicate":
                target = of_type(signed, "tst1")[0]["offset"]
                path, records = self.mutate("flat-data-predicate-no-reused-coverage.mp4", filename, signed, [
                    (target + 8, "change covered predicate so its exclusion no longer matches"),
                    (target + 24, "previously excluded byte must not reuse stale coverage")])
                self.whole("flat-data-predicate-no-reused-coverage", path, False, records)
            if name == "xpath":
                # CBOR text /tst1 occurs once in the signed assertion. Change only
                # its last byte, preserving valid CBOR and every enclosing size.
                candidates = []
                for root in of_type(signed, "uuid"):
                    start, end = root["payloadOffset"], root["end"]
                    if signed[start:start + 16] == C2PA_UUID:
                        pos = signed.find(b"/tst1", start, end)
                        while pos != -1:
                            candidates.append(pos + 4)
                            pos = signed.find(b"/tst1", pos + 1, end)
                require(len(candidates) == 1, "descriptor tamper must have one unambiguous target")
                path, records = self.mutate("flat-signed-descriptor-tampered.mp4", filename, signed, [
                    (candidates[0], "change signed /tst1 to /tst0 without resigning; assertion hash must fail")])
                self.whole("flat-signed-descriptor-tampered", path, False, records, assertion_tamper=True)

    def merkle(self):
        source = self.input("python", "tests/fixtures/single-file-fragmented/single_file_fragments_sidx.mp4")
        require(source == self.input("sdk", "sdk/tests/fixtures/single_file_fragments_sidx.mp4"),
                "Python and SDK synthetic fMP4 fixtures differ")
        require(sha256(source) == SIDX_SOURCE_SHA256 and len(source) == 3892,
                "unexpected pinned synthetic fMP4 source bytes")
        # Native 602 single_file_per_fragment_sidx_belongs_to_the_previous_leaf
        # and extra_sidx_exclusion_lets_sidx_cut_segments_verify both assert 3.
        require(len(of_type(source, "moof")) == len(of_type(source, "mdat"))
                == len(of_type(source, "sidx")) == 3,
                "pinned per-fragment-sidx source must have three fragments")
        for name, exclusions in [("merkle-default", []), ("merkle-sidx", [{"xpath": "/sidx"}])]:
            filename, signed = self.sign(name, source, exclusions)
            roots = boxes(signed)
            uuids = [b for b in roots if b["type"] == "uuid"
                     and signed[b["payloadOffset"]:b["payloadOffset"] + 16] == C2PA_UUID
                     and signed[b["payloadOffset"] + 20:b["payloadOffset"] + 27] == b"merkle\0"]
            sidx, mdats, moofs = (of_type(signed, kind) for kind in ("sidx", "mdat", "moof"))
            require(len(uuids) == len(sidx) == len(mdats) == len(moofs) == 3,
                    "expected exactly three one-track Merkle fragments")
            maps = self.recipes[name]["bmffAssertion"]["data"].get("merkle", [])
            require(len(maps) == 1 and maps[0]["count"] == len(uuids),
                    "signed assertion must describe all three fixture fragments")
            for index in range(len(uuids)):
                require(sidx[index]["end"] == uuids[index]["offset"]
                        and uuids[index]["end"] == moofs[index]["offset"]
                        and moofs[index]["end"] == mdats[index]["offset"],
                        "unexpected sidx/merkle/moof/mdat ordering")
            self.recipes[name]["fragmentCount"] = len(uuids)
            self.recipes[name]["cuts"] = []
            for cut_name, starts, ends in [
                ("uuid", [b["offset"] for b in uuids],
                 [b["offset"] for b in uuids[1:]] + [len(signed)]),
                ("sidx", [b["offset"] for b in sidx], [b["end"] for b in mdats]),
            ]:
                init = self.write(f"{name}/{cut_name}-init.mp4", signed[:starts[0]], layout=True)
                init_controls = []
                if exclusions and cut_name == "uuid":
                    init_data = signed[:starts[0]]
                    indexes = of_type(init_data, "sidx")
                    require(len(indexes) == 1 and indexes[0]["end"] == len(init_data),
                            "UUID init must end with the complete first sidx")
                    sidx_byte = indexes[0]["payloadOffset"] + 12
                    require(sidx_byte < indexes[0]["end"], "init sidx mutation outside its payload")
                    moovs = of_type(init_data, "moov")
                    require(len(moovs) == 1, "UUID init must contain one moov")
                    movie_headers = [b for b in boxes(init_data, moovs[0]["payloadOffset"], moovs[0]["end"])
                                     if b["type"] == "mvhd"]
                    require(len(movie_headers) == 1, "UUID init must contain one moov/mvhd")
                    mvhd = movie_headers[0]
                    payload = mvhd["payloadOffset"]
                    require(payload + 4 <= mvhd["end"], "truncated mvhd FullBox header")
                    version = init_data[payload]
                    require(version in (0, 1), "unsupported mvhd version")
                    # After version/flags, creation/modification times and timescale,
                    # duration ends at payload+20 (v0) or payload+32 (v1).
                    duration_end = payload + (20 if version == 0 else 32)
                    require(duration_end <= mvhd["end"], "truncated mvhd duration")
                    self.recipes[name]["initControls"] = []
                    for suffix, offset, valid, reason in [
                        ("init-excluded-sidx", sidx_byte, True,
                         "excluded first /sidx payload byte in the initialization hash"),
                        ("init-covered-duration", duration_end - 1, False,
                         "covered /moov/mvhd duration low byte in the initialization hash"),
                    ]:
                        path, records = self.mutate(f"{name}/{suffix}.mp4", init, init_data, [(offset, reason)])
                        init_controls.append((suffix, path, valid, records))
                        self.recipes[name]["initControls"].append({
                            "init": path, "sourceInit": init, "valid": valid, "mutations": records,
                            "mvhdVersion": version, "originalFragmentCount": len(starts)})
                for index, (start, end) in enumerate(zip(starts, ends)):
                    segment = self.write(f"{name}/{cut_name}-{index}.m4s", signed[start:end], layout=True)
                    self.recipes[name]["cuts"].append({"kind": cut_name, "init": init,
                        "fragment": segment, "fragmentBaseOffset": start, "end": end})
                    self.fragment(f"{name}-{cut_name}-{index}", init, segment, start,
                                  valid=cut_name == "uuid" or bool(exclusions))
                    for suffix, changed_init, valid, records in init_controls:
                        self.fragment(f"{name}-{cut_name}-{index}-{suffix}", changed_init,
                                      segment, start, valid, records)
                    if exclusions and cut_name == "sidx":
                        offset = sidx[index]["payloadOffset"] + 12 - start
                        path, records = self.mutate(f"{name}/sidx-{index}-redelivery.m4s", segment,
                            signed[start:end], [(offset, "same-length excluded sidx payload edit on redelivery")])
                        self.fragment(f"{name}-sidx-{index}-redelivery", init, path, start, mutations=records)
                    if exclusions and cut_name == "uuid" and index == 1:
                        self.fragment(name + "-wrong-offset", init, segment, start + 1, False)
                        self.fragment(name + "-missing-offset", init, segment, None, False)
                        self.fragment(name + "-zero-offset", init, segment, 0, False)
                        # The next UUID belongs to the next leaf. Keep its moof/
                        # mdat out: a delivery boundary split the following leaf.
                        bad_end = uuids[index + 1]["end"]
                        bad = self.write(name + "/misgrouped.m4s", signed[start:bad_end], layout=True)
                        self.fragment(name + "-misgrouped-candidate", init, bad, start, False)
                        self.fragment(name + "-correct-regroup", init, segment, start)
                if cut_name == "uuid":
                    # Native 602 hashes this entire stream for EACH selector;
                    # multiple complete leaves still require per-leaf regrouping.
                    start = starts[0]
                    contiguous = self.write(name + "/uuid-contiguous.m4s", signed[start:], layout=True)
                    self.fragment(name + "-uuid-contiguous-delivery", init, contiguous, start, False)
            index = 1
            # Keep the already-validated init identical across head/regroup
            # controls, so missing init coverage cannot explain a rejection.
            known_init = name + "/uuid-init.mp4"
            self.fragment(name + "-leading-head-valid-init", known_init,
                          name + "/sidx-1.m4s", sidx[index]["offset"], bool(exclusions))
            if not exclusions:
                self.fragment(name + "-included-head-regrouped", known_init,
                              name + "/uuid-1.m4s", uuids[index]["offset"])
            for suffix, offset, valid in [
                ("sidx-payload", sidx[index]["payloadOffset"] + 12, bool(exclusions)),
                ("media-payload", mdats[index]["payloadOffset"] + 10, False),
            ]:
                path, records = self.mutate(f"{name}/{suffix}.mp4", filename, signed, [
                    (offset, "excluded index payload" if valid else "covered payload control")])
                self.whole(name + "-whole-" + suffix, path, valid, records)
                if exclusions and suffix == "media-payload":
                    start, end = uuids[index]["offset"], uuids[index + 1]["offset"]
                    changed = (self.out / path).read_bytes()
                    init = name + "/uuid-init.mp4"
                    segment = self.write(name + "/uuid-media-tampered.m4s", changed[start:end], layout=True)
                    local_records = [{**record, "file": segment, "offset": record["offset"] - start}
                                     for record in records]
                    self.fragment(name + "-fragment-media-tampered", init, segment, start, False, local_records)

    def finish(self, complete):
        verdicts = {"schemaVersion": 1, "producer": self.producer,
                    "generationComplete": complete, "qualified": complete and not self.errors,
                    "generationFailure": self.generation_failure,
                    "cases": self.verdicts, "errors": self.errors}
        self.write("native-verdicts.json", (json.dumps(verdicts, indent=2, sort_keys=True) + "\n").encode())
        manifest = {
            "schemaVersion": 1, "producer": self.producer, "files": self.files, "cases": self.cases,
            "provenance": {"inputs": self.inputs,
                "credentials": "Public repository ES256 test credentials; never production identity",
                "nativeVerdicts": "native-verdicts.json",
                "nativeSourceReferences": [
                    "sdk/src/settings/builder.rs:646-785",
                    "sdk/src/asset_handlers/bmff_io.rs:749-891",
                    "sdk/src/assertions/single_file_bmff_tests.rs:1622-1866",
                    "sdk/src/assertion.rs:333-342",
                    "sdk/src/utils/hash_utils.rs:676-724",
                    "sdk/src/manifest.rs:603-608",
                    "sdk/src/reader.rs:757-786",
                    "sdk/src/manifest_store_report.rs:28-48,83-110",
                ]},
            "layout": self.layouts, "recipes": self.recipes,
            "metadata": {
                "mimeType": "video/mp4", "offsetUnits": "bytes",
                "predicateOffsets": "box-relative, including the BMFF header",
                "mutationValues": "before/after are individual unsigned byte integers",
                "trust": "verify_trust=false only; binding and assertion verification remain enabled; not Trusted",
                "redelivery": "Every case gets a fresh Reader; expectations do not endorse stale coverage caching",
                "statusComparison": "Required success subset; exact failure sets (none for Valid, only BMFF mismatch for ordinary Invalid); descriptor tamper requires hashedURI mismatch and permits only an additional BMFF mismatch",
                "initCoverage": "For /sidx exclusion, mutate the first sidx in UUID-init and the covered mvhd duration separately; reuse all three original UUID-cut leaves with correct absolute offsets",
                "headControl": "Middle sidx-cut and UUID-regrouped candidates reuse the same known-valid UUID-init; covered-head rejection is not inferred from a missing covered init box",
                "repeatability": "Fixed inputs, recipes, case names and mutations; native salts/signatures/labels may vary",
                "generationComplete": complete,
                "qualified": complete and not self.errors,
                "sourceNativeProof": {
                    "fullBoxResolution": {"source": "sdk/src/asset_handlers/bmff_io.rs:2072-2106",
                        "basis": "implementation: mfhd is in FULL_BOX_TYPES; resolver reads version/flags and skips the bounded remaining fields"},
                    "uuidCuts": {"source": "sdk/src/assertions/single_file_bmff_tests.rs:1434-1449",
                                 "basis": "native test: default per-sidx source has three UUID-delimited leaves"},
                    "sidxCuts": {"source": "sdk/src/assertions/single_file_bmff_tests.rs:1714-1729",
                                  "basis": "native test: /sidx exclusion accepts all three sidx cuts and UUID cuts"},
                    "initHash": {"source": "sdk/src/assertions/bmff_hash.rs:1490-1511,2258-2278",
                        "basis": "implementation: signer hashes the prefix before first moof; fragment verifier hashes supplied init with the assertion exclusions, rejecting a covered-byte change before checking the leaf"},
                    "initAndLeaves": {"source": "sdk/src/assertions/single_file_bmff_tests.rs:1680-1711",
                        "basis": "native test independently recomputes initialization and every leaf hash with /sidx excluded"},
                    "defaultSidxCuts": {"source": "sdk/src/assertions/single_file_bmff_tests.rs:1361-1372,1435-1449; sdk/src/assertions/bmff_hash.rs:2258-2278",
                        "basis": "native test rejects the middle cut; implementation-derived rejection of all cuts, including final leaf, because their common init omits the covered first sidx"},
                    "misgrouping": {"source": "sdk/src/assertions/single_file_bmff_tests.rs:1247-1258",
                                    "basis": "native test: next UUID without its leaf's media is a BMFF mismatch"},
                    "contiguousDelivery": {"source": "sdk/src/assertions/bmff_hash.rs:2207-2319",
                        "basis": "implementation-derived: entire stream hashed per selector, not split into leaves; no required passing fastpath"},
                },
                "limitations": [
                    "No VSI producer, JavaScript descriptor authority, network, TSA, or separate-file signing is exercised.",
                    "FullBox probes use resolver-known root mfhd with exact field lengths but synthetic placement/nonzero reserved flags; they test exclusion resolution, not movie playback conformance.",
                    "Pure nonmatching-rule controls intentionally have no excluded mutation; matching counterparts are separate cases.",
                    "Both source revisions, consumed reference bytes, installed Python binding bytes, and published Linux native-library digest are enforced; no native rebuild is performed.",
                    "Native 602 verify_stream_segment_with_progress hashes the entire supplied fragment for each selector; multi-leaf contiguous deliveries require regrouping, even when complete. Whole-file Reader remains valid.",
                ],
            },
        }
        # manifest.json cannot include its own content hash.
        with (self.out / "manifest.json").open("x", encoding="utf-8") as output:
            json.dump(manifest, output, indent=2, sort_keys=True)
            output.write("\n")


def main():
    require(len(sys.argv) == 4,
            "usage: python tools/bmff-exclusion-fixtures.py <python-reference-root> <sdk-reference-root> <output-dir>")
    fixtures = Fixtures(*(Path(arg).resolve() for arg in sys.argv[1:]))
    complete = False
    stage = "prepare"
    try:
        fixtures.prepare()
        stage = "flat"
        fixtures.flat()
        stage = "merkle"
        fixtures.merkle()
        complete = True
    except BaseException as error:
        fixtures.generation_failure = {"stage": stage, "type": type(error).__name__,
                                       "message": str(error), "traceback": traceback.format_exc()}
        fixtures.errors.append(f"generation/{stage}: {type(error).__name__}: {error}")
        raise
    finally:
        # Preserve partial verdicts even if setup, signing or layout checks fail.
        try:
            fixtures.finish(complete)
        except Exception as reporting_error:
            if fixtures.generation_failure is None:
                raise
            # A filesystem/reporting failure must not hide the original cause.
            print(f"Could not finish diagnostic artifacts: {reporting_error}", file=sys.stderr)
    require(not fixtures.errors, "native fixture qualification failed:\n" + "\n".join(fixtures.errors))
    print(f"Qualified {len(fixtures.cases)} BMFF cases; manifest: {fixtures.out / 'manifest.json'}")


if __name__ == "__main__":
    main()
