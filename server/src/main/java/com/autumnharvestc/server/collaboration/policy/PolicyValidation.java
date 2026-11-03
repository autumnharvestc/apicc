package com.autumnharvestc.server.collaboration.policy;

import com.autumnharvestc.server.core.ApiException;
import org.springframework.http.HttpStatus;
import java.net.URI;
import java.net.URISyntaxException;
import java.util.*;
import java.util.regex.Pattern;
import static com.autumnharvestc.server.collaboration.policy.PolicyReadView.*;
import static com.autumnharvestc.server.collaboration.policy.PolicyReadView.Code.*;

final class PolicyValidation {
    private static final Pattern HEADER=Pattern.compile("[!#$%&'*+\\-.^_`|~0-9A-Za-z]+");
    private static final Pattern POINTER=Pattern.compile("^(?:/(?:[^~]|~[01])*)?$");
    private PolicyValidation() {}
    static final class Invalid extends ApiException {
        final Code field;
        Invalid(String code,Code field,Source source){super(HttpStatus.BAD_REQUEST,code,"协作策略设置不合法（来源："+source.code()+"）："+field.code()+"；请按显示的范围、单位及关联约束修改");this.field=field;}
    }
    static void requireValid(List<Setting> settings) {requireValid(settings,Source.PROJECT);}
    static void requireValid(List<Setting> settings,Source source) {
        var values=new EnumMap<Code,Setting>(Code.class);settings.forEach(item->values.put(item.code(),item));
        int sensitive=0;
        for(var item:settings) {
            if(item instanceof IntegerSetting number) {
                long maximum=number.code()==DEFAULT_SHARE_DURATION_MS?((IntegerSetting)values.get(MAX_SHARE_DURATION_MS)).maximum():number.maximum();
                if(number.effective()<number.minimum()||number.effective()>maximum)throw problem("collaboration_policy_range_invalid",number.code(),source);
            }else if(item instanceof StringListSetting list) {
                if(list.effective().size()>list.maxItems())throw problem("collaboration_policy_range_invalid",list.code(),source);
                for(String value:list.effective()) {
                    if(value.codePointCount(0,value.length())>list.maxItemCodePoints())throw problem("collaboration_policy_range_invalid",list.code(),source);
                    if(list.code()==EXTRA_SENSITIVE_HEADERS&&!HEADER.matcher(value).matches()
                        ||list.code()==EXTRA_SENSITIVE_POINTERS&&!POINTER.matcher(value).matches())throw problem("collaboration_policy_sensitive_rule_invalid",list.code(),source);
                    if(list.code()==CORS_ALLOWED_ORIGINS)requireOrigin(value,source);
                }
                if(list.code()!=CORS_ALLOWED_ORIGINS)sensitive+=list.effective().size();
            }
        }
        if(sensitive>200)throw problem("collaboration_policy_combination_invalid",EXTRA_SENSITIVE_FIELDS,source);
        if(number(values,MAX_FIELD_BYTES)>number(values,MAX_EVIDENCE_BYTES)||number(values,MAX_EVIDENCE_BYTES)>number(values,MAX_ARTIFACT_BYTES))
            throw problem("collaboration_policy_combination_invalid",MAX_EVIDENCE_BYTES,source);
        if(number(values,DEFAULT_SHARE_DURATION_MS)>number(values,MAX_SHARE_DURATION_MS))throw problem("collaboration_policy_combination_invalid",DEFAULT_SHARE_DURATION_MS,((IntegerSetting)values.get(MAX_SHARE_DURATION_MS)).source());
        if(number(values,DEFAULT_PAGE_SIZE)>number(values,MAX_PAGE_SIZE))throw problem("collaboration_policy_combination_invalid",DEFAULT_PAGE_SIZE,((IntegerSetting)values.get(MAX_PAGE_SIZE)).source());
    }
    private static long number(Map<Code,Setting> values,Code code){return ((IntegerSetting)values.get(code)).effective();}
    private static void requireOrigin(String value,Source source) {
        try {
            var origin=new URI(value);String scheme=origin.getScheme(),path=origin.getRawPath();
            if(scheme==null||!(scheme.equalsIgnoreCase("http")||scheme.equalsIgnoreCase("https"))||origin.getHost()==null
                ||origin.getRawUserInfo()!=null||origin.getRawQuery()!=null||origin.getRawFragment()!=null||path!=null&&!path.isEmpty())
                throw problem("collaboration_policy_origin_invalid",CORS_ALLOWED_ORIGINS,source);
        }catch(URISyntaxException invalid){throw problem("collaboration_policy_origin_invalid",CORS_ALLOWED_ORIGINS,source);}
    }
    private static Invalid problem(String code,Code field,Source source){return new Invalid(code,field,source);}
}
