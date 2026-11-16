package frame.api.dvr;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import frame.api.FrameProperties;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Synthetic MP4 metadata fixtures only; actual H.264/AAC decoding belongs to the media e2e. */
class RecordedAssetProbeTest {
    @TempDir Path root;
    private static final String NAME="2026-11-16_13-00-00-000000+0900.mp4";
    private RecordedAssetProbe probe(){FrameProperties properties=mock(FrameProperties.class);when(properties.dvr()).thenReturn(new FrameProperties.Dvr(true,root.toString()));return new RecordedAssetProbe(properties);}
    @Test void missingInitialDirectoryIsNormalAndTimestampNamesCannotTraverse()throws Exception{
        RecordedAssetProbe probe=probe();assertTrue(probe.enabled());assertThrows(java.nio.file.NoSuchFileException.class,()->probe.directory("new-source"));
        assertEquals(Instant.parse("2026-11-16T04:00:00Z").toEpochMilli(),RecordedAssetProbe.timestamp(NAME));
        for(String value:new String[]{"../"+NAME,"2026-02-30_13-00-00-000000Z.mp4","2026-11-16_13-00-00-000000+2459.mp4","other.mp4"})assertNull(RecordedAssetProbe.timestamp(value));
        assertThrows(java.io.IOException.class,()->probe.directory("../private"));
    }
    @Test void openMovieHeaderIsRecordingUntilMediaMtxWritesItsCloseDuration()throws Exception{
        var probe=probe();Path directory=Files.createDirectories(root.resolve("source/rec")),file=directory.resolve(NAME);
        Files.write(file,movie(false,false,false));var prefix=probe.info("source",NAME);assertFalse(prefix.complete());assertFalse(prefix.corrupt());assertNull(prefix.durationMs());
        Files.write(file,movie(false,true,false));var growing=probe.info("source",NAME);assertFalse(growing.complete());assertFalse(growing.corrupt());assertEquals(1000,growing.durationMs());
        Files.write(file,movie(true,true,false));var closed=probe.info("source",NAME);assertTrue(closed.complete());assertFalse(closed.corrupt());assertEquals(1000,closed.durationMs());
        Files.write(file,movie(true,true,true));assertEquals(2000,probe.info("source",NAME).durationMs()); // Include an audio tail beyond the video samples.
        Files.writeString(file,"This is not an MP4 recording");assertTrue(probe.info("source",NAME).corrupt());
    }
    private static byte[] movie(boolean closed,boolean fragment,boolean audio){
        ByteArrayOutputStream out=new ByteArrayOutputStream();out.writeBytes(box("ftyp",concat("iso5".getBytes(StandardCharsets.US_ASCII),ints(0))));
        byte[] tracks=track(1,"vide"),defaults=box("trex",ints(0,1,1,0,0,0));
        if(audio){tracks=concat(tracks,track(2,"soun"));defaults=concat(defaults,box("trex",ints(0,2,1,0,0,0)));}
        out.writeBytes(box("moov",concat(box("mvhd",ints(0,0,0,1000,closed?1000:0)),tracks,box("mvex",defaults))));
        if(fragment){int count=audio?2:1,moofSize=8+16+76*count;ByteArrayOutputStream moof=new ByteArrayOutputStream();moof.writeBytes(box("mfhd",ints(0,1)));
            for(int id=1;id<=count;id++){byte[] tfhd=box("tfhd",ints(0x020000,id)),tfdt=box("tfdt",ByteBuffer.allocate(12).putInt(0x01000000).putLong(0).array()),trun=box("trun",ints(0x000701,1,moofSize+8+(id-1)*4,id==2?2000:1000,4,0x02000000));moof.writeBytes(box("traf",concat(tfhd,tfdt,trun)));}
            out.writeBytes(box("moof",moof.toByteArray()));out.writeBytes(box("mdat",new byte[4*count]));
        }
        return out.toByteArray();
    }
    private static byte[] track(int id,String handler){return box("trak",concat(box("tkhd",ints(3,0,0,id,0,0,0)),box("mdia",concat(box("mdhd",ints(0,0,0,1000,0,0)),box("hdlr",concat(ints(0,0),handler.getBytes(StandardCharsets.US_ASCII),ints(0,0,0)))))));}
    private static byte[] box(String type,byte[] body){return ByteBuffer.allocate(8+body.length).putInt(8+body.length).put(type.getBytes(StandardCharsets.US_ASCII)).put(body).array();}
    private static byte[] ints(int... values){ByteBuffer bytes=ByteBuffer.allocate(values.length*4);for(int value:values)bytes.putInt(value);return bytes.array();}
    private static byte[] concat(byte[]... values){ByteArrayOutputStream bytes=new ByteArrayOutputStream();for(byte[] value:values)bytes.writeBytes(value);return bytes.toByteArray();}
}
