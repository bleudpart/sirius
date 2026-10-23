"""Authenticated streaming multipart endpoints: audio stays in bounded RAM."""

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from python_multipart import MultipartParser
from python_multipart.exceptions import MultipartParseError
from python_multipart.multipart import parse_options_header

from voice_identity import MAX_CLIP_BYTES, MAX_REFERENCES, MIN_REFERENCES, VoiceIdentityService


async def memory_multipart(request: Request, *, enroll: bool):
    content_type, options = parse_options_header(request.headers.get("content-type"))
    boundary = options.get(b"boundary", b"")
    if content_type != b"multipart/form-data" or not 1 <= len(boundary) <= 100:
        raise HTTPException(415, "Audio multipart requis.")
    maximum = (MAX_REFERENCES if enroll else 1) * MAX_CLIP_BYTES + 16384
    try:
        if int(request.headers.get("content-length", "0")) > maximum:
            raise HTTPException(413, "Envoi vocal trop volumineux.")
    except ValueError as error:
        raise HTTPException(400, "Taille invalide.") from error
    files, fields = [], {}
    part = {}
    completed = False
    count = 0

    def begin():
        nonlocal count
        count += 1
        if count > (MAX_REFERENCES + 1 if enroll else 1):
            raise HTTPException(413, "Trop de parties multipart.")
        part.clear()
        part.update({"headers": {}, "field": bytearray(), "value": bytearray(),
                     "data": bytearray(), "header_size": 0})

    def header_data(key, data, start, end):
        part["header_size"] += end - start
        if part["header_size"] > 4096:
            raise HTTPException(413, "En-têtes audio trop volumineux.")
        part[key].extend(data[start:end])

    def header_end():
        part["headers"][bytes(part["field"]).lower()] = bytes(part["value"])
        part["field"].clear()
        part["value"].clear()

    def headers_finished():
        disposition, opts = parse_options_header(part["headers"].get(b"content-disposition"))
        name = opts.get(b"name", b"")
        is_file = b"filename" in opts
        if disposition != b"form-data" or (is_file and name != (b"files" if enroll else b"file")):
            raise HTTPException(422, "Champ audio invalide.")
        if not is_file and (not enroll or name != b"consent" or name in fields):
            raise HTTPException(422, "Champ de consentement invalide.")
        part.update({"name": name, "is_file": is_file})

    def part_data(data, start, end):
        if len(part["data"]) + end - start > (MAX_CLIP_BYTES if part.get("is_file") else 16):
            raise HTTPException(413, "Chaque extrait vocal est limité à 3 Mio.")
        part["data"].extend(data[start:end])

    def part_end():
        data = bytes(part["data"])
        if part["is_file"]:
            if not data:
                raise HTTPException(422, "Extrait vocal vide.")
            files.append(data)
        else:
            fields[part["name"]] = data

    def finish():
        nonlocal completed
        completed = True

    parser = MultipartParser(boundary, {
        "on_part_begin": begin, "on_header_field": lambda *args: header_data("field", *args),
        "on_header_value": lambda *args: header_data("value", *args),
        "on_header_end": header_end, "on_headers_finished": headers_finished,
        "on_part_data": part_data, "on_part_end": part_end, "on_end": finish,
    }, max_size=maximum)
    total = 0
    try:
        async with asyncio.timeout(20):
            async for chunk in request.stream():
                total += len(chunk)
                if total > maximum:
                    raise HTTPException(413, "Envoi vocal trop volumineux.")
                parser.write(chunk)
            parser.finalize()
    except (MultipartParseError, KeyError) as error:
        raise HTTPException(400, "Audio multipart invalide.") from error
    except TimeoutError as error:
        raise HTTPException(408, "Envoi vocal expiré.") from error
    if not completed:
        raise HTTPException(400, "Audio multipart incomplet.")
    if enroll:
        if fields.get(b"consent") != b"true":
            raise HTTPException(422, "Consentement explicite requis (consent=true).")
        if not MIN_REFERENCES <= len(files) <= MAX_REFERENCES:
            raise HTTPException(422, "Trois à cinq références vocales sont requises.")
    elif len(files) != 1:
        raise HTTPException(422, "Un extrait vocal est requis.")
    return files


def make_voice_identity_router(db, require_user, *, service=None):
    async def no_store(response: Response):
        response.headers["Cache-Control"] = "no-store"

    router = APIRouter(prefix="/api/voice-identity", tags=["voice-identity"],
                       dependencies=[Depends(no_store)])
    service = service if service is not None else VoiceIdentityService(db)

    async def authorize(request, operation):
        # The shared auth dependency is always authoritative, including on localhost.
        uid = (await require_user(request, db))["user_id"]
        await service.rate_limit(uid, operation)
        return uid

    @router.get("/status")
    async def status(request: Request):
        return await service.status(await authorize(request, "status"))

    @router.post("/enroll")
    async def enroll(request: Request):
        uid = await authorize(request, "enroll")
        clips = await memory_multipart(request, enroll=True)
        return await service.enroll(uid, clips)

    @router.post("/verify")
    async def verify(request: Request):
        uid = await authorize(request, "verify")
        clips = await memory_multipart(request, enroll=False)
        return await service.verify(uid, clips[0])

    @router.delete("/profile")
    async def delete(request: Request):
        return await service.delete(await authorize(request, "delete"))

    return router
