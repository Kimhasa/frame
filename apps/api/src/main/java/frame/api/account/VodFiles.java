package frame.api.account;

import frame.api.FrameProperties;
import frame.api.dvr.RecordedAssetProbe;
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
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/** App-owned UUID copies only. Source recordings are opened read-only and never changed or removed. */
@Component
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public final class VodFiles {
    public record Info(long size,long modified,String key,String sha256) {}
    private final Path root;
    private final RecordedAssetProbe recordings;
    public VodFiles(FrameProperties properties,Environment environment,RecordedAssetProbe recordings){
        this.recordings=recordings;
        String configured=environment.getProperty("frame.product.vod-dir",environment.getProperty("FRAME_PRODUCT_VOD_DIR",""));
        String source=properties.dvr().recordDir();
        Path raw=source==null||source.isBlank()?null:Path.of(source).toAbsolutePath().normalize();
        root=configured!=null&&!configured.isBlank()?Path.of(configured).toAbsolutePath().normalize()
                :raw!=null&&raw.getParent()!=null?raw.resolveSibling("vod"):null;
        if(root!=null&&raw!=null&&(root.startsWith(raw)||raw.startsWith(root)))throw new IllegalArgumentException("VOD storage must be separate from the source recording directory");
    }
    public boolean enabled(){return root!=null;}
    private void directory(boolean create)throws IOException{
        if(root==null)throw new IOException("VOD storage is not configured");
        if(create&&!Files.exists(root,LinkOption.NOFOLLOW_LINKS)){
            Path parent=root.getParent();
            while(parent!=null&&!Files.exists(parent,LinkOption.NOFOLLOW_LINKS))parent=parent.getParent();
            if(parent==null||!parent.toRealPath().equals(parent))throw new IOException("Unsafe VOD directory");
            Files.createDirectories(root);
        }
        var attributes=Files.readAttributes(root,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
        if(!attributes.isDirectory()||attributes.isSymbolicLink()||attributes.isOther()||!root.toRealPath().equals(root))throw new IOException("Unsafe VOD directory");
    }
    private Path file(UUID id,String suffix)throws IOException{directory(false);return root.resolve(id+suffix);}
    private BasicFileAttributes attributes(Path file)throws IOException{
        var value=Files.readAttributes(file,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
        if(!value.isRegularFile()||value.isSymbolicLink()||value.isOther()||!file.toRealPath().equals(file))throw new IOException("Unsafe VOD file");
        return value;
    }
    public Info inspect(UUID id)throws IOException{
        var value=attributes(file(id,".mp4"));return new Info(value.size(),value.lastModifiedTime().toMillis(),String.valueOf(value.fileKey()),null);
    }
    public boolean matches(UUID id,long size,Long modified,String key){
        if(modified==null||key==null)return false;
        try{Info value=inspect(id);return value.size()==size&&value.modified()==modified&&value.key().equals(key);}catch(IOException|RuntimeException unavailable){return false;}
    }
    public FileChannel open(UUID id,long size,Long modified,String key)throws IOException{
        if(!matches(id,size,modified,key))throw new NoSuchFileException("VOD copy unavailable");
        FileChannel channel=FileChannel.open(file(id,".mp4"),StandardOpenOption.READ,LinkOption.NOFOLLOW_LINKS);
        if(channel.size()!=size){channel.close();throw new IOException("VOD copy changed");}return channel;
    }
    public void discardPart(UUID id)throws IOException{
        if(root==null||!Files.exists(root,LinkOption.NOFOLLOW_LINKS))return;
        Path part=file(id,".part");if(Files.exists(part,LinkOption.NOFOLLOW_LINKS)){attributes(part);Files.delete(part);}
    }
    private void verifySource(ChannelRecordings.Asset asset)throws IOException{
        var value=recordings.info(asset.path(),asset.name());
        if(!value.complete()||value.corrupt()||value.size()!=asset.size()||value.modified()!=asset.modified()
                ||!java.util.Objects.equals(value.key(),asset.key())||!ChannelRecordings.contained(asset.recorded(),value.durationMs(),asset.windowStart(),asset.windowEnd()))
            throw new IOException("Source recording changed");
    }
    /** Called only for a preparing row by the single worker; ready archives are never repair targets. */
    public Info copy(UUID id,ChannelRecordings.Asset asset)throws IOException{
        verifySource(asset);directory(true);discardPart(id);
        Path part=file(id,".part"),target=file(id,".mp4");boolean existing=Files.exists(target,LinkOption.NOFOLLOW_LINKS);
        if(existing)attributes(target);
        MessageDigest digest=digest();long written=0,until=System.nanoTime()+TimeUnit.MINUTES.toNanos(2);
        try(var source=recordings.open(asset.path(),asset.name());
            var output=FileChannel.open(part,StandardOpenOption.CREATE_NEW,StandardOpenOption.WRITE,LinkOption.NOFOLLOW_LINKS)){
            if(source.size()!=asset.size())throw new IOException("Source recording changed");
            ByteBuffer buffer=ByteBuffer.allocate(256*1024);
            while(written<asset.size()){
                if(Thread.currentThread().isInterrupted()||System.nanoTime()>until)throw new IOException("VOD preparation interrupted");
                buffer.clear().limit((int)Math.min(buffer.capacity(),asset.size()-written));int count=source.read(buffer);
                if(count<=0)throw new IOException("Source recording ended early");
                digest.update(buffer.array(),0,count);buffer.flip();while(buffer.hasRemaining())output.write(buffer);
                written+=count;
            }
            output.force(true);
        }catch(IOException|RuntimeException failure){discardPart(id);throw failure;}
        verifySource(asset);String hash=HexFormat.of().formatHex(digest.digest());
        // A crash may leave an unpublished final artifact. Rebuild only this guarded UUID from the verified source.
        if(existing&&attributes(target).size()==asset.size()&&hash.equals(hash(target)))discardPart(id);
        else Files.move(part,target,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
        if(!hash.equals(hash(target)))throw new IOException("VOD copy content changed");
        Info value=inspect(id);if(value.size()!=asset.size())throw new IOException("VOD copy changed");
        return new Info(value.size(),value.modified(),value.key(),hash);
    }
    private static String hash(Path file)throws IOException{
        MessageDigest hash=digest();long until=System.nanoTime()+TimeUnit.MINUTES.toNanos(2);try(var input=FileChannel.open(file,StandardOpenOption.READ,LinkOption.NOFOLLOW_LINKS)){
            ByteBuffer buffer=ByteBuffer.allocate(256*1024);while(input.read(buffer)>0){
                if(Thread.currentThread().isInterrupted()||System.nanoTime()>until)throw new IOException("VOD verification interrupted");
                buffer.flip();hash.update(buffer);buffer.clear();
            }
        }return HexFormat.of().formatHex(hash.digest());
    }
    private static MessageDigest digest(){try{return MessageDigest.getInstance("SHA-256");}catch(NoSuchAlgorithmException impossible){throw new IllegalStateException(impossible);}}
}
