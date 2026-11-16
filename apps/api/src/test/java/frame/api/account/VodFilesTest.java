package frame.api.account;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import frame.api.FrameProperties;
import frame.api.dvr.RecordedAssetProbe;
import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.env.MockEnvironment;

/** Synthetic bytes isolate archive integrity and safety; real MP4 decoding belongs to the media e2e. */
class VodFilesTest {
    @TempDir Path temporary;
    @Test void copiesVerifiedSourceWithoutChangingItAndReusesOnlyIdenticalCompletedCopies()throws Exception{
        Path source=temporary.resolve("source.mp4"),archive=temporary.resolve("vod");
        byte[] payload=new byte[700_003];for(int i=0;i<payload.length;i++)payload[i]=(byte)(i*31);Files.write(source,payload);
        var probe=mock(RecordedAssetProbe.class);var asset=asset(payload.length);
        when(probe.info(asset.path(),asset.name())).thenReturn(new RecordedAssetProbe.Info(payload.length,10,"source-key",1000L,true,false));
        when(probe.open(asset.path(),asset.name())).thenAnswer(ignored->FileChannel.open(source,StandardOpenOption.READ));
        VodFiles files=store(archive,probe);UUID id=UUID.randomUUID();
        var copied=files.copy(id,asset);assertArrayEquals(payload,Files.readAllBytes(source));assertArrayEquals(payload,Files.readAllBytes(archive.resolve(id+".mp4")));
        assertEquals(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(payload)),copied.sha256());
        assertTrue(files.matches(id,copied.size(),copied.modified(),copied.key()));assertFalse(Files.exists(archive.resolve(id+".part")));
        assertEquals(copied,files.copy(id,asset));
        try(var opened=files.open(id,copied.size(),copied.modified(),copied.key())){assertEquals(payload.length,opened.size());}
        Files.write(archive.resolve(id+".mp4"),new byte[payload.length]);
        assertEquals(copied.sha256(),files.copy(id,asset).sha256());assertArrayEquals(payload,Files.readAllBytes(archive.resolve(id+".mp4")));
        Files.write(archive.resolve(id+".mp4"),new byte[]{9});assertEquals(payload.length,files.copy(id,asset).size());assertArrayEquals(payload,Files.readAllBytes(source));
    }
    @Test void sourceMustRemainCompleteAndIdenticalAndOnlyOwnPartIsDiscarded()throws Exception{
        var probe=mock(RecordedAssetProbe.class);Path archive=temporary.resolve("vod");Files.createDirectories(archive);UUID id=UUID.randomUUID(),other=UUID.randomUUID();
        Files.write(archive.resolve(id+".part"),new byte[]{1});Files.write(archive.resolve(other+".part"),new byte[]{2});
        var files=store(archive,probe);files.discardPart(id);assertFalse(Files.exists(archive.resolve(id+".part")));assertTrue(Files.exists(archive.resolve(other+".part")));
        var asset=asset(3);when(probe.info(asset.path(),asset.name())).thenReturn(new RecordedAssetProbe.Info(3,10,"source-key",1000L,false,false));
        assertThrows(IOException.class,()->files.copy(id,asset));assertFalse(Files.exists(archive.resolve(id+".mp4")));verify(probe,never()).open(anyString(),anyString());
        when(probe.info(asset.path(),asset.name())).thenReturn(new RecordedAssetProbe.Info(3,11,"source-key",1000L,true,false));assertThrows(IOException.class,()->files.copy(id,asset));
    }
    @Test void regularFileAtArchiveRootFailsSafelyThenSameIdCanRetry()throws Exception{
        var probe=mock(RecordedAssetProbe.class);Path source=temporary.resolve("source.mp4"),archive=temporary.resolve("vod");Files.write(source,new byte[]{1,2,3});Files.write(archive,new byte[]{9});
        var asset=asset(3);when(probe.info(asset.path(),asset.name())).thenReturn(new RecordedAssetProbe.Info(3,10,"source-key",1000L,true,false));
        when(probe.open(asset.path(),asset.name())).thenAnswer(ignored->FileChannel.open(source,StandardOpenOption.READ));
        var files=store(archive,probe);UUID id=UUID.randomUUID();assertTrue(files.enabled());assertThrows(IOException.class,()->files.copy(id,asset));assertArrayEquals(new byte[]{9},Files.readAllBytes(archive));
        Files.delete(archive);assertEquals(3,files.copy(id,asset).size());
    }
    @Test void rawAndArchiveMustBeSeparateAndDisabledStorageNeverTouchesDisk(){
        var properties=properties(temporary.resolve("raw"));var probe=mock(RecordedAssetProbe.class);
        for(Path invalid:new Path[]{temporary.resolve("raw"),temporary.resolve("raw/nested"),temporary})
            assertThrows(IllegalArgumentException.class,()->new VodFiles(properties,new MockEnvironment().withProperty("frame.product.vod-dir",invalid.toString()),probe));
        var empty=properties(Path.of("."));when(empty.dvr()).thenReturn(new FrameProperties.Dvr(false,""));var disabled=new VodFiles(empty,new MockEnvironment(),probe);assertFalse(disabled.enabled());assertFalse(disabled.matches(UUID.randomUUID(),3,1L,"key"));
    }
    @Test void fileFingerprintAndMovingObservationWindowHaveDistinctRules()throws Exception{
        var before=asset(3);var advanced=new ChannelRecordings.Asset(before.id(),before.path(),before.name(),before.size(),before.modified(),before.key(),before.recorded(),before.windowStart(),before.windowEnd()+2000);
        assertTrue(VodPublisher.sameSource(before,advanced));
        assertFalse(VodPublisher.sameSource(before,new ChannelRecordings.Asset(before.id(),before.path(),before.name(),before.size(),before.modified()+1,before.key(),before.recorded(),before.windowStart(),before.windowEnd())));
        var files=store(temporary.resolve("vod"),mock(RecordedAssetProbe.class));UUID id=UUID.randomUUID();assertFalse(files.matches(id,3,null,null));assertThrows(IOException.class,()->files.open(id,3,1L,"key"));
    }
    private VodFiles store(Path archive,RecordedAssetProbe probe){return new VodFiles(properties(temporary.resolve("raw")),new MockEnvironment().withProperty("frame.product.vod-dir",archive.toString()),probe);}
    private static FrameProperties properties(Path raw){var properties=mock(FrameProperties.class);when(properties.dvr()).thenReturn(new FrameProperties.Dvr(true,raw.toString()));return properties;}
    private static ChannelRecordings.Asset asset(long size){return new ChannelRecordings.Asset(UUID.randomUUID(),"obs-test","2026-11-16_12-00-00-000000+0000.mp4",size,10,"source-key",2000,1000,5000);}
}
