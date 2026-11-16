package frame.api.account;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.Test;

class RecordingControllerTest {
    @Test void selectsFullSingleOpenEndedAndSuffixByteIntervals() {
        assertArrayEquals(new long[] {0, 99}, RecordingController.range(null, 100));
        assertArrayEquals(new long[] {0, 0}, RecordingController.range("bytes=0-0", 100));
        assertArrayEquals(new long[] {20, 39}, RecordingController.range("bytes=20-39", 100));
        assertArrayEquals(new long[] {90, 99}, RecordingController.range("bytes=90-", 100));
        assertArrayEquals(new long[] {99, 99}, RecordingController.range("bytes=99-", 100));
        assertArrayEquals(new long[] {90, 99}, RecordingController.range("bytes=-10", 100));
        assertArrayEquals(new long[] {99, 99}, RecordingController.range("bytes=-1", 100));
    }

    @Test void clampsValidRequestsWithoutCreatingBytesOutsideTheFile() {
        assertArrayEquals(new long[] {90, 99}, RecordingController.range("bytes=90-200", 100));
        assertArrayEquals(new long[] {0, 99}, RecordingController.range("bytes=0-999999999999999999", 100));
        assertArrayEquals(new long[] {0, 99}, RecordingController.range("bytes=-100", 100));
        assertArrayEquals(new long[] {0, 99}, RecordingController.range("bytes=-999999999999999999", 100));
        assertArrayEquals(new long[] {0, 0}, RecordingController.range("bytes=0-", 1));
        assertArrayEquals(new long[] {0, 9223372036854775806L}, RecordingController.range(null, Long.MAX_VALUE));
        assertNull(RecordingController.range(null, 0));
        assertNull(RecordingController.range("bytes=0-0", 0));
        assertNull(RecordingController.range(null, -1));
    }

    @Test void rejectsMalformedMultipleOverflowingAndUnsatisfiableRanges() {
        for (String value : new String[] {
                "", "bytes=", "bytes=-", "bytes=-0", "bytes=100-", "bytes=100-110", "bytes=30-20",
                "bytes=0-1,4-5", "bytes=--1", "bytes=-1-3", "bytes=+1-3", "bytes=1.5-3", "bytes=0-1e2",
                "bytes= 0-9", "bytes=0 -9", "bytes=0-9 ", "items=0-9", "Bytes=0-9",
                "bytes=9223372036854775808-", "bytes=0-18446744073709551616", "bytes=-18446744073709551616"
        }) assertNull(RecordingController.range(value, 100), value);
    }
}
