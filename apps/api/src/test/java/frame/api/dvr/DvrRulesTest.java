package frame.api.dvr;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The DVR rules of server/lib/dvr.mjs and fmp4.mjs on a synthetic MediaMTX-like recording. */
class DvrRulesTest {
    private static final int TS = 90_000, FRAME = 3000, FRAMES_PER_PART = 30, GOP = 60, SAMPLE = 100;

    @Test
    void fileNamesGiveTheRecordingStart() {
        assertEquals(Instant.parse("2026-10-28T02:27:35.354Z").toEpochMilli() + 0.294, Recordings.segmentStart("2026-10-28_11-27-35-354294+0900.mp4"), 1e-6);
        assertEquals(Instant.parse("2026-10-28T11:27:35Z").toEpochMilli(), Recordings.segmentStart("2026-10-28_11-27-35-000000Z.mp4"), 1e-6);
        assertNull(Recordings.segmentStart("2026-10-28_11-27-35.mp4"));
        // An odd offset is plain arithmetic (as Node), never an exception that would break the whole path's DVR.
        assertEquals(Instant.parse("2026-10-27T10:28:35Z").toEpochMilli(), Recordings.segmentStart("2026-10-28_11-27-35-000000+2459.mp4"), 1e-6);
    }

    @Test
    void rangesAreParsedAsTheNodeRelayDoes() {
        assertArrayEquals(new long[] {0, 99}, DvrController.range("bytes=0-", 100));
        assertArrayEquals(new long[] {90, 99}, DvrController.range("bytes=-10", 100));
        assertArrayEquals(new long[] {10, 99}, DvrController.range("bytes=10-500", 100));
        assertNull(DvrController.range("bytes=5-1", 100));
        assertNull(DvrController.range("bytes=0-1,4-5", 100));
        long[] unsatisfiable = DvrController.range("bytes=100-", 100);
        assertSame(unsatisfiable, DvrController.range("bytes=-0", 100));
        assertEquals(-1, unsatisfiable[0]);
    }

    @Test
    void segmentsAreCutAtKeyframesAndBuiltAsNewFragments(@TempDir Path dir) throws Exception {
        Path file = dir.resolve("2026-10-28_11-27-35-000000Z.mp4");
        Files.write(file, recording(10));
        RecordFile f = new RecordFile(file, file.getFileName().toString(), Recordings.segmentStart(file.getFileName().toString()));
        f.scan();
        assertEquals(TS, f.videoTimescale());
        // Growing file: the open last group is not listed (keyframes at 0, 2, 4, 6, 8 s; 10 s on disk).
        f.group(false, Recordings.SEGMENT_S);
        assertEquals(2, f.segmentCount());
        assertEquals(new RecordFile.Segment(0, 4 * TS, 0, 4, true, false), f.segment(0));
        // Final: the rest becomes an open-ended segment.
        f.group(true, Recordings.SEGMENT_S);
        assertEquals(3, f.segmentCount());
        assertEquals(8 * TS, f.segment(2).start());
        assertEquals(10 * TS, f.segment(2).end());
        assertTrue(f.segment(2).openEnd());

        RecordFile.Fragment frag = f.fragment(f.segment(1), 2);
        assertNotNull(frag);
        assertEquals("moof", new String(frag.moof(), 4, 4, StandardCharsets.ISO_8859_1));
        assertEquals(4 * TS / FRAME * SAMPLE, frag.payload());  // 4 s of samples, copied byte for byte
        assertEquals(4, frag.runs().size());  // one byte run per recorded part (4..7)
        long listed = f.listedBytes();
        assertEquals(Files.size(file), listed);

        Recordings.HlsState st = new Recordings.HlsState("0123456789abcdef0123456789abcdef");
        st.files.add(f);
        String m3u8 = Recordings.playlistText(st);
        assertTrue(m3u8.startsWith("#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n"), m3u8);
        String uri = "dvr/file.mp4?id=0123456789abcdef0123456789abcdef&f=" + f.fileId;
        assertTrue(m3u8.contains("#EXT-X-MAP:URI=\"" + uri + "\",BYTERANGE=\"" + f.initSize() + "@0\""), m3u8);
        assertTrue(m3u8.contains("#EXT-X-PROGRAM-DATE-TIME:2026-10-28T11:27:39.000Z\n#EXTINF:4.00000,\n" + uri + "&s=1\n"), m3u8);
        // Retention removed the file: the playlist continues with the media sequence counting it.
        f.gone = true;
        assertTrue(Recordings.playlistText(st).contains("#EXT-X-MEDIA-SEQUENCE:3\n#EXT-X-DISCONTINUITY-SEQUENCE:1\n"));
    }

    // ---- a recording as MediaMTX writes it: ftyp, moov (one H.264 track), then 1 s parts (moof + mdat) ---------------

    private static byte[] recording(int seconds) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.writeBytes(box("ftyp", bytes("iso5", 512, "iso5", "iso6", "mp41")));
        byte[] tkhd = box("tkhd", ints(0x00000003, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0));
        byte[] mdhd = box("mdhd", ints(0, 0, 0, TS, 0, 0));
        byte[] hdlr = box("hdlr", concat(ints(0, 0), "vide".getBytes(StandardCharsets.ISO_8859_1), ints(0, 0, 0), new byte[] {0}));
        byte[] trak = box("trak", concat(tkhd, box("mdia", concat(mdhd, hdlr))));
        byte[] mvex = box("mvex", box("trex", ints(0, 1, 1, 0, 0, 0)));
        out.writeBytes(box("moov", concat(trak, mvex)));
        for (int part = 0; part < seconds; part++) {
            int count = FRAMES_PER_PART, trunSize = 8 + 12 + 12 * count, trafSize = 8 + 16 + 20 + trunSize, moofSize = 8 + 16 + trafSize;
            ByteBuffer moof = ByteBuffer.allocate(moofSize);
            moof.putInt(moofSize).put(tag("moof")).putInt(16).put(tag("mfhd")).putInt(0).putInt(part + 1);
            moof.putInt(trafSize).put(tag("traf"));
            moof.putInt(16).put(tag("tfhd")).putInt(0x020000).putInt(1);
            moof.putInt(20).put(tag("tfdt")).putInt(0x01000000).putLong((long) part * count * FRAME);
            moof.putInt(trunSize).put(tag("trun")).putInt(0x000701).putInt(count).putInt(moofSize + 8);
            for (int i = 0; i < count; i++) {
                int frame = part * count + i;
                moof.putInt(FRAME).putInt(SAMPLE).putInt(frame % GOP == 0 ? 0x02000000 : 0x01010000);
            }
            out.writeBytes(moof.array());
            out.writeBytes(box("mdat", new byte[count * SAMPLE]));
        }
        return out.toByteArray();
    }

    private static byte[] box(String type, byte[] payload) {
        return ByteBuffer.allocate(8 + payload.length).putInt(8 + payload.length).put(tag(type)).put(payload).array();
    }

    private static byte[] tag(String s) { return s.getBytes(StandardCharsets.ISO_8859_1); }

    private static byte[] ints(int... values) {
        ByteBuffer b = ByteBuffer.allocate(values.length * 4);
        for (int v : values) b.putInt(v);
        return b.array();
    }

    private static byte[] bytes(String brand, int version, String... compatible) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.writeBytes(tag(brand));
        out.writeBytes(ints(version));
        for (String c : compatible) out.writeBytes(tag(c));
        return out.toByteArray();
    }

    private static byte[] concat(byte[]... parts) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (byte[] p : parts) out.writeBytes(p);
        return out.toByteArray();
    }
}
