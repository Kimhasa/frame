package frame.api.account;

import frame.api.FrameProperties;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/** One bounded encoder. Only guarded UUID files in the clip folder are written or replaced. */
@Component
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public final class ClipFiles {
    static final long MAX_BYTES=512L*1024*1024;
    public record Info(long size,long duration,long modified,String key,String sha256){}
    private final Path root;private final String ffmpeg;private final VodFiles vods;
    private volatile Process child;
    public ClipFiles(FrameProperties properties,Environment environment,VodFiles vods){
        this.vods=vods;ffmpeg=properties.quality().ffmpeg();
        Path raw=path(properties.dvr().recordDir());
        Path vod=path(environment.getProperty("frame.product.vod-dir",environment.getProperty("FRAME_PRODUCT_VOD_DIR","")));if(vod==null&&raw!=null&&raw.getParent()!=null)vod=raw.resolveSibling("vod");
        Path selected=path(environment.getProperty("frame.product.clip-dir",environment.getProperty("FRAME_PRODUCT_CLIP_DIR","")));root=selected!=null?selected:vod!=null&&vod.getParent()!=null?vod.resolveSibling("clips"):null;
        if(root!=null&&(overlap(root,raw)||overlap(root,vod)))throw new IllegalArgumentException("Clip storage must be separate from source recording and VOD directories");
    }
    private static Path path(String input){return input==null||input.isBlank()?null:Path.of(input).toAbsolutePath().normalize();}
    private static boolean overlap(Path one,Path two){return two!=null&&(one.startsWith(two)||two.startsWith(one));}
    public boolean enabled(){return root!=null&&ffmpeg!=null&&!ffmpeg.isBlank();}
    private void directory(boolean create)throws IOException{
        if(root==null)throw new IOException("Clip storage not configured");
        if(create&&!Files.exists(root,LinkOption.NOFOLLOW_LINKS)){Path parent=root.getParent();while(parent!=null&&!Files.exists(parent,LinkOption.NOFOLLOW_LINKS))parent=parent.getParent();if(parent==null||!parent.toRealPath().equals(parent))throw new IOException("Unsafe clip directory");Files.createDirectories(root);}
        var value=Files.readAttributes(root,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);if(!value.isDirectory()||value.isSymbolicLink()||value.isOther()||!root.toRealPath().equals(root))throw new IOException("Unsafe clip directory");
    }
    private Path file(UUID id,String suffix)throws IOException{directory(false);return root.resolve(id+suffix);}
    private static BasicFileAttributes attributes(Path file)throws IOException{var value=Files.readAttributes(file,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);if(!value.isRegularFile()||value.isSymbolicLink()||value.isOther()||!file.toRealPath().equals(file))throw new IOException("Unsafe clip file");return value;}
    public boolean matches(UUID id,long size,Long modified,String key){if(modified==null||key==null)return false;try{var value=attributes(file(id,".mp4"));return value.size()==size&&value.lastModifiedTime().toMillis()==modified&&String.valueOf(value.fileKey()).equals(key);}catch(IOException|RuntimeException unavailable){return false;}}
    public FileChannel open(UUID id,long size,Long modified,String key)throws IOException{if(!matches(id,size,modified,key))throw new NoSuchFileException("Clip unavailable");var channel=FileChannel.open(file(id,".mp4"),StandardOpenOption.READ,LinkOption.NOFOLLOW_LINKS);if(channel.size()!=size){channel.close();throw new IOException("Clip changed");}return channel;}
    public void discardPart(UUID id)throws IOException{if(root==null||!Files.exists(root,LinkOption.NOFOLLOW_LINKS))return;Path part=file(id,".part");if(Files.exists(part,LinkOption.NOFOLLOW_LINKS)){attributes(part);Files.delete(part);}}
    public Info encode(UUID id,ProductVods.ClipSource source,long start,long end)throws IOException,InterruptedException{
        if(!enabled())throw new IOException("Clip encoder unavailable");ProductClips.bounds(start,end,source.duration());
        long until=System.nanoTime()+TimeUnit.SECONDS.toNanos(120);Path input=verifyInput(source,until);directory(true);discardPart(id);Path part=file(id,".part"),target=file(id,".mp4");if(Files.exists(target,LinkOption.NOFOLLOW_LINKS))attributes(target);
        // CREATE_NEW rejects an unexpected symlink; FFmpeg writes only the already guarded local output path.
        Files.createFile(part);
        Process running=null;
        try{
            ProcessBuilder builder=new ProcessBuilder(arguments(ffmpeg,input,part,start,end));builder.redirectOutput(ProcessBuilder.Redirect.DISCARD).redirectError(ProcessBuilder.Redirect.DISCARD);
            running=builder.start();child=running;
            while(!running.waitFor(100,TimeUnit.MILLISECONDS)){
                if(Thread.currentThread().isInterrupted()||System.nanoTime()>until||attributes(part).size()>MAX_BYTES)throw new IOException("Clip encoder exceeded its bound");
            }
            if(running.exitValue()!=0)throw new IOException("Clip encoder failed");
            verifyInput(source,until);long duration=duration(part);if(Math.abs(duration-(end-start))>500||duration>61000)throw new IOException("Clip duration differs from the requested range");
            var value=attributes(part);if(value.size()<=0||value.size()>MAX_BYTES)throw new IOException("Clip size outside bounds");String hash=hash(part,until);
            Files.move(part,target,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);var saved=attributes(target);
            if(saved.size()!=value.size()||!hash.equals(hash(target,until)))throw new IOException("Clip changed after finalization");
            return new Info(saved.size(),duration,saved.lastModifiedTime().toMillis(),String.valueOf(saved.fileKey()),hash);
        }finally{
            if(running!=null)terminate(running);if(child==running)child=null;discardPart(id);
        }
    }
    private Path verifyInput(ProductVods.ClipSource source,long until)throws IOException{
        Path input=vods.clipInput(source.id(),source.size(),source.modified(),source.key());if(!source.hash().equals(hash(input,until)))throw new IOException("Source VOD content changed");return input;
    }
    static List<String> arguments(String binary,Path input,Path output,long start,long end){return List.of(binary,"-hide_banner","-nostdin","-loglevel","error","-y","-threads","1","-filter_threads","1","-protocol_whitelist","file,pipe","-ss",seconds(start),"-i",input.toString(),"-t",seconds(end-start),"-map","0:v:0","-map","0:a:0?","-sn","-dn","-c:v","libx264","-threads:v","1","-preset","veryfast","-crf","21","-bf","0","-pix_fmt","yuv420p","-fps_mode","passthrough","-c:a","aac","-threads:a","1","-b:a","128k","-avoid_negative_ts","make_zero","-movflags","+faststart","-fs",Long.toString(MAX_BYTES),"-f","mp4",output.toString());}
    private static String seconds(long millis){return String.format(Locale.ROOT,"%.3f",millis/1000.0);}
    /** Final FFmpeg MP4, not the MediaMTX-specific fragmented recording parser. Bounded metadata only. */
    static long duration(Path file)throws IOException{
        var value=attributes(file);long size=value.size();if(size<24||size>MAX_BYTES)throw new IOException("Invalid clip size");
        try(var channel=FileChannel.open(file,StandardOpenOption.READ,LinkOption.NOFOLLOW_LINKS)){
            long offset=0,duration=0,metadata=0;int count=0;boolean movie=false,data=false;
            while(offset<size){if(++count>4096||size-offset<8)throw new IOException("Invalid MP4 boxes");ByteBuffer header=read(channel,offset,(int)Math.min(16,size-offset));long length=u32(header,0);String type=tag(header,4);int head=8;if(offset==0&&!type.equals("ftyp"))throw new IOException("Missing MP4 type");if(length==1){if(header.remaining()<16)throw new IOException("Truncated MP4 box");length=header.getLong(8);head=16;}if(length<head||length>size-offset)throw new IOException("Truncated MP4 box");
                if(type.equals("moov")){metadata+=length;if(movie||length>8*1024*1024||metadata>16*1024*1024)throw new IOException("Invalid MP4 metadata");ByteBuffer bytes=read(channel,offset+head,(int)length-head);movie=true;for(int at=0;at<bytes.limit();){if(bytes.limit()-at<8)throw new IOException("Truncated movie metadata");long n=u32(bytes,at);if(n<8||n>bytes.limit()-at)throw new IOException("Invalid movie metadata");if(tag(bytes,at+4).equals("mvhd")){int base=at+8;if(n<32)throw new IOException("Missing movie clock");int version=Byte.toUnsignedInt(bytes.get(base));if(version>1||version==1&&n<44)throw new IOException("Invalid movie clock");long scale=u32(bytes,base+(version==1?20:12)),ticks=version==1?bytes.getLong(base+24):u32(bytes,base+16);if(scale<=0||ticks<=0)throw new IOException("Invalid movie duration");duration=(long)Math.ceil(ticks*1000.0/scale);}at+=(int)n;}}
                if(type.equals("mdat")){if(length<=head)throw new IOException("Empty media");data=true;}offset+=length;
            }
            if(!movie||!data||duration<=0||duration>61000)throw new IOException("Incomplete clip MP4");return duration;
        }catch(IndexOutOfBoundsException malformed){throw new IOException("Truncated movie metadata",malformed);}
    }
    private static ByteBuffer read(FileChannel channel,long offset,int size)throws IOException{ByteBuffer bytes=ByteBuffer.allocate(size);while(bytes.hasRemaining()){int n=channel.read(bytes,offset+bytes.position());if(n<=0)throw new IOException("Short MP4 metadata");}return bytes.flip();}
    private static long u32(ByteBuffer bytes,int offset){return Integer.toUnsignedLong(bytes.getInt(offset));}
    private static String tag(ByteBuffer bytes,int at){return new String(new byte[]{bytes.get(at),bytes.get(at+1),bytes.get(at+2),bytes.get(at+3)},java.nio.charset.StandardCharsets.US_ASCII);}
    private static String hash(Path file,long until)throws IOException{MessageDigest digest;try{digest=MessageDigest.getInstance("SHA-256");}catch(NoSuchAlgorithmException impossible){throw new IllegalStateException(impossible);}try(var channel=FileChannel.open(file,StandardOpenOption.READ,LinkOption.NOFOLLOW_LINKS)){ByteBuffer bytes=ByteBuffer.allocate(256*1024);while(channel.read(bytes)>0){if(Thread.currentThread().isInterrupted()||System.nanoTime()>until)throw new IOException("Clip preparation interrupted");bytes.flip();digest.update(bytes);bytes.clear();}}return HexFormat.of().formatHex(digest.digest());}
    private static void terminate(Process process){if(!process.isAlive())return;process.destroy();try{if(!process.waitFor(500,TimeUnit.MILLISECONDS))process.destroyForcibly();}catch(InterruptedException interrupted){process.destroyForcibly();Thread.currentThread().interrupt();}}
    public void stop(){Process running=child;if(running!=null)terminate(running);}
}
