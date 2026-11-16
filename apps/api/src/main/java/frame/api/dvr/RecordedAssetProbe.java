package frame.api.dvr;

import frame.api.FrameProperties;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;

/** Bounded, read-only access to MediaMTX fMP4 files. Existing live DVR state and parsing rules stay untouched. */
@Component
@ConditionalOnProperty(name="frame.product.enabled",havingValue="true")
public final class RecordedAssetProbe {
    public static final long MAX_BYTES=64L*1024*1024*1024;
    public record Info(long size,long modified,String key,Long durationMs,boolean complete,boolean corrupt) {}
    private record Box(String type,int start,int end) {}
    private record Track(long scale,long duration) {}
    private final Path root;
    private final boolean enabled;
    public RecordedAssetProbe(FrameProperties properties){String directory=properties.dvr().recordDir();enabled=properties.dvr().enabled()&&directory!=null&&!directory.isBlank();root=enabled?Path.of(directory).toAbsolutePath().normalize():null;}
    public boolean enabled(){return enabled;}
    public Path directory(String path)throws IOException{
        if(!enabled)throw new NoSuchFileException("Recording storage is disabled");
        if(!path.matches("[A-Za-z0-9][A-Za-z0-9_-]{0,63}"))throw new IOException("Invalid recording scope");
        Path directory=root.resolve(path).resolve("rec").normalize();check(directory,true);return directory;
    }
    public Path file(String path,String name)throws IOException{
        if(timestamp(name)==null)throw new IOException("Invalid recording name");
        Path file=directory(path).resolve(name).normalize();check(file,false);return file;
    }
    private void check(Path target,boolean directory)throws IOException{
        if(!target.startsWith(root)||!target.toRealPath().equals(target.toAbsolutePath().normalize()))throw new IOException("Unsafe recording path");
        BasicFileAttributes attributes=Files.readAttributes(target,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
        if(attributes.isSymbolicLink()||attributes.isOther()||(directory?!attributes.isDirectory():!attributes.isRegularFile()))throw new IOException("Unsafe recording entry");
    }
    public Info info(String path,String name)throws IOException{
        Path file=file(path,name);BasicFileAttributes attributes=Files.readAttributes(file,BasicFileAttributes.class,LinkOption.NOFOLLOW_LINKS);
        long size=attributes.size(),modified=attributes.lastModifiedTime().toMillis();String key=String.valueOf(attributes.fileKey());
        if(size<=0||size>MAX_BYTES)return new Info(size,modified,key,null,false,true);
        try(FileChannel channel=FileChannel.open(file,StandardOpenOption.READ,LinkOption.NOFOLLOW_LINKS)){
            Map<Long,Track> tracks=new HashMap<>();double[] span={Double.POSITIVE_INFINITY,Double.NEGATIVE_INFINITY};long offset=0,totalMetadata=0,movieDuration=0;int boxes=0;boolean movie=false,fragment=false;
            while(offset<size){
                if(++boxes>4096)return new Info(size,modified,key,null,false,true);
                if(size-offset<8)return new Info(size,modified,key,null,false,false);
                ByteBuffer header=read(channel,offset,(int)Math.min(16,size-offset));long length=u32(header,0);String type=tag(header,4);int head=8;
                if(offset==0&&!type.equals("ftyp"))return new Info(size,modified,key,null,false,true);
                if(length==1){if(header.remaining()<16)return new Info(size,modified,key,null,false,false);length=header.getLong(8);head=16;}
                if(length<head)return new Info(size,modified,key,null,false,true);
                if(length>size-offset)return new Info(size,modified,key,null,false,false);
                if(type.equals("moov")||type.equals("moof")){
                    totalMetadata+=length;if(length>8*1024*1024||totalMetadata>16*1024*1024)return new Info(size,modified,key,null,false,true);
                    ByteBuffer metadata=read(channel,offset+head,(int)length-head);
                    if(type.equals("moov")){movieDuration=parseMovie(metadata,tracks);movie=true;}else{if(!movie)throw new IllegalArgumentException("Fragment precedes movie");parseFragment(metadata,tracks,span);fragment=true;}
                }
                offset+=length;
            }
            RecordFile parsed=new RecordFile(file,name,timestamp(name));parsed.scan();parsed.group(true,4);
            boolean insufficient=!movie||!fragment||parsed.segmentCount()==0||!Double.isFinite(span[0])||!Double.isFinite(span[1]);
            if(insufficient&&movieDuration==0&&!parsed.broken())return new Info(size,modified,key,null,false,false);
            boolean corrupt=parsed.broken()||insufficient;
            Long duration=corrupt?null:Math.max(movieDuration,(long)Math.ceil(span[1]-span[0]));
            if(duration!=null&&(duration<=0||duration>7L*86400000))return new Info(size,modified,key,null,false,true);
            return new Info(size,modified,key,duration,!corrupt&&movieDuration>0,corrupt);
        }catch(IllegalArgumentException|IndexOutOfBoundsException failure){return new Info(size,modified,key,null,false,true);}
    }
    public FileChannel open(String path,String name)throws IOException{return FileChannel.open(file(path,name),StandardOpenOption.READ,LinkOption.NOFOLLOW_LINKS);}
    public static Long timestamp(String name){
        if(name==null||!name.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{6}(Z|[+-][0-9]{4})[.]mp4"))return null;
        try{String zone=name.substring(26,name.length()-4);ZoneOffset offset=zone.equals("Z")?ZoneOffset.UTC:ZoneOffset.of(zone.substring(0,3)+":"+zone.substring(3));return LocalDateTime.parse(name.substring(0,26),DateTimeFormatter.ofPattern("uuuu-MM-dd_HH-mm-ss-SSSSSS").withResolverStyle(java.time.format.ResolverStyle.STRICT)).toInstant(offset).toEpochMilli();}catch(RuntimeException failure){return null;}
    }
    private static ByteBuffer read(FileChannel channel,long offset,int size)throws IOException{ByteBuffer value=ByteBuffer.allocate(size);while(value.hasRemaining()){int n=channel.read(value,offset+value.position());if(n<=0)throw new IOException("Short recording metadata");}return value.flip();}
    private static long u32(ByteBuffer bytes,int at){return Integer.toUnsignedLong(bytes.getInt(at));}
    private static String tag(ByteBuffer bytes,int at){return new String(new byte[]{bytes.get(at),bytes.get(at+1),bytes.get(at+2),bytes.get(at+3)},java.nio.charset.StandardCharsets.US_ASCII);}
    private static List<Box> boxes(ByteBuffer bytes,int start,int end){List<Box> result=new ArrayList<>();for(int at=start;at<end;){if(end-at<8)throw new IllegalArgumentException();long length=u32(bytes,at);if(length<8||length>end-at)throw new IllegalArgumentException();result.add(new Box(tag(bytes,at+4),at+8,at+(int)length));at+=(int)length;}return result;}
    private static long parseMovie(ByteBuffer bytes,Map<Long,Track> tracks){
        long closedDuration=0;
        Map<Long,Long> scales=new HashMap<>(),defaults=new HashMap<>();
        for(Box box:boxes(bytes,0,bytes.limit())){
            if(box.type().equals("mvhd")){int at=box.start(),version=Byte.toUnsignedInt(bytes.get(at));long scale=u32(bytes,at+(version==1?20:12)),duration=version==1?bytes.getLong(at+24):u32(bytes,at+16);if(scale>0&&duration>0)closedDuration=(long)Math.ceil(duration*1000.0/scale);}
            if(box.type().equals("trak")){long id=0,scale=0;for(Box item:boxes(bytes,box.start(),box.end())){
                if(item.type().equals("tkhd"))id=u32(bytes,item.start()+(bytes.get(item.start())==1?20:12));
                if(item.type().equals("mdia"))for(Box info:boxes(bytes,item.start(),item.end()))if(info.type().equals("mdhd"))scale=u32(bytes,info.start()+(bytes.get(info.start())==1?20:12));
            }if(id>0&&scale>0)scales.put(id,scale);}
            if(box.type().equals("mvex"))for(Box item:boxes(bytes,box.start(),box.end()))if(item.type().equals("trex"))defaults.put(u32(bytes,item.start()+4),u32(bytes,item.start()+12));
        }
        scales.forEach((id,scale)->tracks.put(id,new Track(scale,defaults.getOrDefault(id,0L))));return closedDuration;
    }
    private static void parseFragment(ByteBuffer bytes,Map<Long,Track> tracks,double[] span){
        for(Box traf:boxes(bytes,0,bytes.limit()))if(traf.type().equals("traf")){
            long id=0,duration=0,dts=0;boolean clock=false;List<Box> runs=new ArrayList<>();
            for(Box box:boxes(bytes,traf.start(),traf.end())){
                int at=box.start();
                if(box.type().equals("tfhd")){int flags=bytes.getInt(at)&0xffffff;id=u32(bytes,at+4);int x=at+8;if((flags&1)!=0)x+=8;if((flags&2)!=0)x+=4;duration=(flags&8)!=0?u32(bytes,x):tracks.getOrDefault(id,new Track(0,0)).duration();}
                if(box.type().equals("tfdt")){dts=bytes.get(at)==1?bytes.getLong(at+4):u32(bytes,at+4);clock=true;}
                if(box.type().equals("trun"))runs.add(box);
            }
            Track track=tracks.get(id);if(track==null||!clock||dts<0)throw new IllegalArgumentException();
            for(Box run:runs){int at=run.start(),flags=bytes.getInt(at)&0xffffff,version=Byte.toUnsignedInt(bytes.get(at));long count=u32(bytes,at+4);int x=at+8;if((flags&1)!=0)x+=4;if((flags&4)!=0)x+=4;if(count>100000)throw new IllegalArgumentException();
                for(int n=0;n<count;n++){long length=(flags&0x100)!=0?u32(bytes,x):duration;if((flags&0x100)!=0)x+=4;if((flags&0x200)!=0)x+=4;if((flags&0x400)!=0)x+=4;long composition=0;if((flags&0x800)!=0){composition=version==1?bytes.getInt(x):u32(bytes,x);x+=4;}if(x>run.end()||length<=0||dts>Long.MAX_VALUE-length)throw new IllegalArgumentException();double first=(dts+composition)*1000.0/track.scale(),last=(dts+composition+length)*1000.0/track.scale();span[0]=Math.min(span[0],first);span[1]=Math.max(span[1],last);dts+=length;}
            }
        }
    }
}
