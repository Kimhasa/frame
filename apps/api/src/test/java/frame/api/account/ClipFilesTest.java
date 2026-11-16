package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import frame.api.FrameProperties;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.env.MockEnvironment;

/** Synthetic MP4 metadata only; real encoding and decoded time ranges are checked by clips-e2e. */
class ClipFilesTest {
    @TempDir Path directory;
    @Test void normalMp4DurationRequiresCompleteMovieAndMedia()throws Exception{
        Path clip=directory.resolve("clip.mp4");Files.write(clip,mp4(6000));assertEquals(6000,ClipFiles.duration(clip));
        byte[] truncated=mp4(6000);Files.write(clip,java.util.Arrays.copyOf(truncated,truncated.length-1));assertThrows(IOException.class,()->ClipFiles.duration(clip));
        Files.write(clip,mp4(0));assertThrows(IOException.class,()->ClipFiles.duration(clip));Files.write(clip,mp4(62000));assertThrows(IOException.class,()->ClipFiles.duration(clip));
        Files.write(clip,ByteBuffer.allocate(16).putInt(Integer.MAX_VALUE).put("ftyp".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).array());assertThrows(IOException.class,()->ClipFiles.duration(clip));
    }
    @Test void sourceDirectoriesCannotBeClipStorageAndUnknownFilesDoNotMatch()throws Exception{
        FrameProperties props=mock(FrameProperties.class);when(props.dvr()).thenReturn(new FrameProperties.Dvr(true,directory.resolve("raw").toString()));when(props.quality()).thenReturn(new FrameProperties.Quality("","ffmpeg","rtsp://127.0.0.1:8554",5000));
        for(Path invalid:new Path[]{directory,directory.resolve("raw"),directory.resolve("raw/clips"),directory.resolve("vod"),directory.resolve("vod/clips")})
            assertThrows(IllegalArgumentException.class,()->new ClipFiles(props,new MockEnvironment().withProperty("frame.product.clip-dir",invalid.toString()),mock(VodFiles.class)));
        var files=new ClipFiles(props,new MockEnvironment().withProperty("frame.product.clip-dir",directory.resolve("clips").toString()),mock(VodFiles.class));assertTrue(files.enabled());UUID id=UUID.randomUUID();assertFalse(files.matches(id,10,null,null));assertThrows(IOException.class,()->files.open(id,10,1L,"key"));
    }
    @Test void cleanupOnlyTouchesTheExactOwnedPartialFile()throws Exception{
        FrameProperties props=mock(FrameProperties.class);when(props.dvr()).thenReturn(new FrameProperties.Dvr(false,""));when(props.quality()).thenReturn(new FrameProperties.Quality("","ffmpeg","rtsp://127.0.0.1:8554",5000));
        Path clips=directory.resolve("clips");Files.createDirectories(clips);var files=new ClipFiles(props,new MockEnvironment().withProperty("frame.product.clip-dir",clips.toString()),mock(VodFiles.class));UUID own=UUID.randomUUID(),other=UUID.randomUUID();
        Files.write(clips.resolve(own+".part"),new byte[]{1});Files.write(clips.resolve(other+".part"),new byte[]{2});Files.write(clips.resolve(own+".mp4"),new byte[]{3});files.discardPart(own);
        assertFalse(Files.exists(clips.resolve(own+".part")));assertArrayEquals(new byte[]{2},Files.readAllBytes(clips.resolve(other+".part")));assertArrayEquals(new byte[]{3},Files.readAllBytes(clips.resolve(own+".mp4")));
    }
    private static byte[] mp4(int duration){
        ByteBuffer ftyp=ByteBuffer.allocate(16).putInt(16).put("ftyp".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putLong(0);
        ByteBuffer movie=ByteBuffer.allocate(108).putInt(108).put("mvhd".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).put(new byte[100]);movie.putInt(20,1000);movie.putInt(24,duration);
        ByteBuffer moov=ByteBuffer.allocate(116).putInt(116).put("moov".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).put(movie.array());
        ByteBuffer mdat=ByteBuffer.allocate(16).putInt(16).put("mdat".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putLong(1);
        return ByteBuffer.allocate(148).put(ftyp.array()).put(moov.array()).put(mdat.array()).array();
    }
}
