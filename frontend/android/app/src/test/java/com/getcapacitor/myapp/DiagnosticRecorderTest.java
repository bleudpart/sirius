package fr.sirius_assistant.app;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import java.util.List;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class DiagnosticRecorderTest {
    private static final int N = UtteranceSegmenter.FRAME_SAMPLES;

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static short[] frame(int seed) {
        short[] f = new short[N];
        for (int i = 0; i < f.length; i++) f[i] = (short) (seed * 31 + i);
        return f;
    }

    private static short[] pcm(File wav) throws IOException {
        byte[] bytes = Files.readAllBytes(wav.toPath());
        ByteBuffer b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        assertEquals("RIFF", new String(bytes, 0, 4));
        int data = b.getInt(40);
        assertEquals(36 + data, b.getInt(4));
        assertEquals(44 + data, bytes.length);
        short[] out = new short[data / 2];
        for (int i = 0; i < out.length; i++) out[i] = b.getShort(44 + i * 2);
        return out;
    }

    @Test
    public void seulesLesPeriodesDEcouteSontEnregistreesALIdentique() throws IOException {
        File dir = new File(tmp.getRoot(), DiagnosticRecorder.DIR_NAME);
        DiagnosticRecorder r = new DiagnosticRecorder(dir);
        r.open();
        long index = 0;
        for (int i = 0; i < 5; i++, index += N) r.onFrame(frame(100 + i), false, 0, index);
        short[] expected = new short[4 * N];
        long start = index;
        for (int i = 0; i < 4; i++, index += N) {
            short[] f = frame(i);
            System.arraycopy(f, 0, expected, i * N, N);
            r.onFrame(f, true, 1, index);
        }
        for (int i = 0; i < 5; i++, index += N) r.onFrame(frame(200 + i), false, 2, index);
        r.onFrame(frame(7), true, 3, index);
        r.finish("stopped");

        List<DiagnosticRecorder.SampleInfo> samples = r.snapshot();
        assertEquals(2, samples.size());
        assertEquals(start, samples.get(0).startSample);
        assertEquals(4 * N, samples.get(0).sampleCount);
        assertEquals("suppressed", samples.get(0).endReason);
        assertArrayEquals(expected, pcm(new File(dir, samples.get(0).file)));
        assertEquals("stopped", samples.get(1).endReason);
        assertArrayEquals(frame(7), pcm(new File(dir, samples.get(1).file)));
        assertTrue(new File(dir, DiagnosticRecorder.MANIFEST).isFile());
    }

    @Test
    public void limitesParEchantillonParSessionEtNombre() throws IOException {
        File dir = tmp.newFolder("d");
        DiagnosticRecorder r = new DiagnosticRecorder(dir, 3 * N, 5 * N, 3, 3);
        r.open();
        long index = 0;
        for (int i = 0; i < 6; i++, index += N) r.onFrame(frame(i), true, 1, index);
        for (int i = 0; i < 6; i++, index += N) r.onFrame(frame(i), true, 2, index);
        for (int i = 0; i < 6; i++, index += N) r.onFrame(frame(i), true, 3, index);
        List<DiagnosticRecorder.SampleInfo> samples = r.snapshot();
        assertEquals(2, samples.size());
        assertEquals(3 * N, samples.get(0).sampleCount);
        assertEquals("limit", samples.get(0).endReason);
        assertEquals(2 * N, samples.get(1).sampleCount);
        assertEquals("budget", samples.get(1).endReason);
        assertEquals(3 * N, pcm(new File(dir, samples.get(0).file)).length);

        DiagnosticRecorder few = new DiagnosticRecorder(tmp.newFolder("e"), 100 * N, 100 * N, 3, 3);
        few.open();
        for (int epoch = 1; epoch <= 5; epoch++) {
            few.onFrame(frame(epoch), true, epoch, index);
            few.onFrame(frame(epoch), false, epoch + 100, index);
        }
        assertEquals(3, few.snapshot().size());
    }

    @Test
    public void segmentsCorrespondentAuBrutALOffsetIndique() throws IOException {
        File dir = tmp.newFolder("seg");
        DiagnosticRecorder r = new DiagnosticRecorder(dir);
        UtteranceSegmenter s = new UtteranceSegmenter();
        r.open();
        int total = 10 + 200;
        for (int n = 0; n < total; n++) {
            if (n == 10) s.setSuppressed(false);
            boolean loud = (n >= 70 && n < 120) || (n >= 190);
            short amp = loud ? (short) 6000 : (short) 50;
            short[] f = new short[N];
            for (int i = 0; i < N; i++) f[i] = (short) ((i % 2 == 0 ? amp : -amp) + (n % 17));
            UtteranceSegmenter.Event e;
            boolean listening;
            long epoch;
            long frameIndex;
            synchronized (s) {
                listening = !s.isSuppressed();
                epoch = s.epoch();
                frameIndex = s.framesProcessed();
                e = s.process(f);
            }
            r.onFrame(f, listening, epoch, frameIndex * N);
            if (e != null) r.onSegment(e);
        }
        r.finish("stopped");

        DiagnosticRecorder.SampleInfo sample = r.snapshot().get(0);
        assertEquals(10L * N, sample.startSample);
        assertEquals(1, sample.segments.size());
        DiagnosticRecorder.SegmentInfo seg = sample.segments.get(0);
        short[] raw = pcm(new File(dir, sample.file));
        short[] segment = pcm(new File(dir, seg.file));
        assertEquals(seg.sampleCount, segment.length);
        assertTrue(seg.offsetSamples >= 0 && seg.offsetSamples + segment.length <= raw.length);
        short[] slice = new short[segment.length];
        System.arraycopy(raw, (int) seg.offsetSamples, slice, 0, slice.length);
        assertArrayEquals(slice, segment);
        assertEquals(seg.speechStartMs * 16 - seg.preRollSamples, sample.startSample + seg.offsetSamples);
    }

    @Test
    public void segmentsBornesEtGenerationPerimeeIgnoree() {
        DiagnosticRecorder r = new DiagnosticRecorder(tmp.getRoot(), 100 * N, 100 * N, 3, 3);
        r.open();
        r.onFrame(frame(1), true, 4, 0);
        short[] pcm = frame(2);
        for (int i = 0; i < 5; i++) {
            r.onSegment(new UtteranceSegmenter.Event(UtteranceSegmenter.Type.UTTERANCE, pcm, N, 0, 0, 20, "silence", 4));
        }
        r.onSegment(new UtteranceSegmenter.Event(UtteranceSegmenter.Type.UTTERANCE, pcm, N, 0, 0, 20, "silence", 3));
        r.onSegment(new UtteranceSegmenter.Event(UtteranceSegmenter.Type.DISCARDED, null, N, 0, 0, 20, "silence", 4));
        assertEquals(3, r.snapshot().get(0).segments.size());
    }

    @Test
    public void nouveauConsentementEffaceEtSuppressionExplicite() throws IOException {
        File dir = new File(tmp.getRoot(), DiagnosticRecorder.DIR_NAME);
        assertTrue(dir.mkdirs());
        assertTrue(new File(dir, "old-raw.wav").createNewFile());

        DiagnosticRecorder r = new DiagnosticRecorder(dir);
        r.open();
        assertFalse(new File(dir, "old-raw.wav").exists());
        r.onFrame(frame(1), true, 1, 0);
        assertTrue(r.isCapturing());
        assertTrue(r.deleteAll() >= 2);
        assertFalse(r.isCapturing());
        assertFalse(dir.exists());
        r.onFrame(frame(2), true, 1, N);
        assertTrue(r.snapshot().isEmpty());
        assertFalse(dir.exists());

        DiagnosticRecorder stopped = new DiagnosticRecorder(dir);
        stopped.finish("stopped");
        stopped.open();
        assertFalse("une session arrêtée ne peut pas rouvrir la capture", stopped.isCapturing());
        assertFalse(dir.exists());
        assertNull(stopped.error());
    }

    @Test
    public void echecIoSignaleUneSeuleFoisSansAudio() throws IOException {
        File blocker = tmp.newFile("not-a-dir");
        DiagnosticRecorder r = new DiagnosticRecorder(new File(blocker, "sub"));
        r.open();
        assertFalse(r.isCapturing());
        assertEquals("io", r.error());
        String failure = r.consumeFailure();
        assertTrue(failure != null && failure.startsWith("Capture de diagnostic arrêtée"));
        assertNull(r.consumeFailure());
        r.onFrame(frame(1), true, 1, 0);
        assertTrue(r.snapshot().isEmpty());
        assertNull(r.consumeFailure());
    }
}
