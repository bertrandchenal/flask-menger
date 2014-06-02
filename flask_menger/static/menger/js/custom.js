"use strict"

var to_money = function(Amount) {
    var DecimalSeparator = Number("1.2").toLocaleString().substr(1,1);

    var AmountWithCommas = Amount.toLocaleString();
    var arParts = String(AmountWithCommas).split(DecimalSeparator);
    var intPart = arParts[0];
    var decPart = (arParts.length > 1 ? arParts[1] : '');
    decPart = (decPart + '00').substr(0,2);

    return intPart + DecimalSeparator + decPart + ' €';
}

var Space = function(name, label) {
    this.name = name;
    this.label = label;
};

var Measure = function(space, name, label) {
    this.space = space;
    this.name = this.space.name + '.' + name;
    this.label = label;
    this.fullname = this.space.label +' / ' + this.label;
};

var Dimension = function(name, label, depth, kw) {
    kw = kw || {};
    this.name = name;
    this.label = label;
    this.value = kw.value || [];
    this.parent = kw.parent;
    this.depth = depth;
    this.dim_select = ko.observable(kw.dim_select);
    this.active = ko.observable(false);
    this.children = [];
    this.fullname = label;
    if (this.value.length) {
        this.fullname = this.value[this.value.length-1];
    }
};

Dimension.prototype.drill = function() {
    var query = {
        'space': this.dim_select().dataset.measures()[0].space.name, // TODO pass all spaces
        'dimension': this.name,
        'value': this.value,
    }

    query = JSON.stringify(query);
    var url = '/mng/drill.json?' + $.param({'query': query});

    $.ajax(url).success(function(res) {
        this.add_children(res.data);
        this.activate();
        this.dim_select().selected(this);
    }.bind(this));
};

Dimension.prototype.add_children = function(names) {
    var children = [];
    for (var pos in names) {
        var name = names[pos];
        var value = this.value.slice();
        value.push(name);
        var child = this.clone({
            'value': value,
            'parent': this,
            'dim_select': this.dim_select(),
        });
        children.push(child);
    }
    this.children = children;
};

Dimension.prototype.clone = function(kw) {
    return new Dimension(
        this.name,
        this.label,
        this.depth,
        kw);
};

Dimension.prototype.activate = function() {
    if (!this.parent) {
        this.dim_select().root(this);
    };
    if (this.active()) {
        this.active(false);
        return;
    }

    this.dim_select().choice().forEach(function(d) {
        d.active(false);
    }.bind(this))
    this.active(true);
};

Dimension.prototype.has_children = function() {
    return this.value.length < this.depth;
};

var DimSelect = function(dataset) {
    this.dataset = dataset;
    this.selected = ko.observable();
    this.root = ko.observable();

    this.available = ko.observable();
    this.set_available(dataset.available_dimensions());

    this.choice = ko.computed(function() {
        var selected = this.selected();
        if (selected){
            return selected.children;
        }
        return this.available();
    }.bind(this));

    this.label = ko.computed(function() {
        return this.root().label;
    }.bind(this));

    this.name = ko.computed(function() {
        return this.root().name;
    }.bind(this));

};

DimSelect.prototype.drill_up = function() {
    this.selected(this.selected().parent);
};

DimSelect.prototype.remove = function() {
    var idx = this.dataset.dimensions.indexOf(this);
    if (idx >= 0) {
        this.dataset.dimensions.splice(idx, 1);
    }
};

DimSelect.prototype.set_available = function(available) {
    var clones = available.map(function (d) {
        var clone = d.clone({dim_select: this});
        return clone
    }.bind(this));
    this.available(clones);
    this.root(clones[0]);
    clones[0].active(true);
};

DimSelect.prototype.get_value = function() {
    var sel = this.selected();
    if (sel) {
        var actives = this.choice().filter(function(d) {
            return d.active();
        });
        if (actives.length) {
            return actives[0].value;
        }
        var val = sel.value.slice();
        val.push(null)
        return val;
    }
    return [null];
};

var DIM_CACHE = {}
var DATA_CACHE = {}

var DataSet = function() {
    this.measures =  ko.observableArray([]);
    this.available_measures = ko.observable([]);
    this.dimensions = ko.observableArray([]);
    this.available_dimensions = ko.observable([]);
    this.data = ko.observable();
    this.columns = ko.observable([]);

    // Fetch meta-data
    $.get('/mng/info.json').success(this.fetch_info.bind(this));

    this.measures.subscribe(this.measures_changed.bind(this));

    // Fetch statistics
    ko.computed(this.fetch_data.bind(this)).extend({rateLimit: 0});;
};


DataSet.prototype.measures_changed = function(measures) {
    var dimensions = DIM_CACHE[measures[0].space.name] || [];
    // Copy list to avoid destroying data
    dimensions = dimensions.slice();
    // Filter dimensions that are available for all measures
    for (var pos=1; pos < measures.length; pos++) {
        var other = DIM_CACHE[measures[pos].space.name]
        for (var x in dimensions) {
            var dname = dimensions[x].name;
            var found = false
            for (var y in other) {
                if (dname == other[y].name) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                dimensions.splice(x, 1);
            }
        }
    }

    this.available_dimensions(dimensions);

    // Clean active dimensions
    var current_dims = this.dimensions();
    if (!current_dims) {
        current_dims = [];
    }
    var available_names = dimensions.map(function(d) {
        return d.name;
    });

    for (var pos in current_dims) {
        var current_name = current_dims[pos].selected().name;
        if (available_names.indexOf(current_name) < 0) {
            current_dims.splice(pos, 1);
        } else {
            current_dims[pos].set_available(dimensions);
        }
    }

    this.dimensions(current_dims)
    if (!current_dims.length) {
        this.push_dimension();
    }
};


DataSet.prototype.push_dimension = function() {
    this.dimensions.push(new DimSelect(this));
};

DataSet.prototype.select_measure = function(selected, pos) {
    var msr = this.measures()
    msr[pos] = selected;
    this.measures(msr);
};

DataSet.prototype.push_measure = function() {
    this.measures.push(this.available_measures()[0]);
};

DataSet.prototype.remove_measure = function(pos) {
    this.measures.splice(pos);
};


DataSet.prototype.push_measure = function() {
    this.measures.push(this.available_measures()[0]);
};


DataSet.prototype.fetch_info = function(info) {
    for (var space_name in info) {
        var dimensions = [];
        for (var pos in info[space_name]['dimensions']) {
            var dim = info[space_name]['dimensions'][pos];
            dimensions.push(new Dimension(dim.name, dim.label, dim.depth));
        }
        DIM_CACHE[space_name] = dimensions;
    }

    var measures = [];
    for (var space_name in info) {
        var space = new Space(space_name, info[space_name]['label']);
        for (var pos in info[space_name]['measures']) {
            var msr = info[space_name]['measures'][pos];
            measures.push(new Measure(space, msr.name, msr.label));
        }
    }
    this.available_measures(measures);
    this.measures([measures[0]])
};

DataSet.prototype.fetch_data = function(mime) {
    var dims = this.dimensions();
    var msrs = this.measures();
    if (!(dims.length && msrs.length)) {
        return;
    }

    var query = {
        'measures': msrs.map(function(m) {return m.name}),
        'dimensions': dims.map(function(d) {
            var value = d.get_value();
            return [d.name(), value]
        }),
    }

    query = JSON.stringify(query);

    // var res = DATA_CACHE[query];
    // if (res) {
    //     this.data(res.data);
    //     return;
    // }

    // Add empty value to prevent double-trigger of query
    DATA_CACHE[query] = {'data': []};

    var url = '/mng/dice.' + (mime || 'json') + '?' + $.param({'query': query});
    if (mime) {
        window.location.href = url;

    } else {
        $.ajax(url).success(this.set_data.bind(this, query))
    }

};

DataSet.prototype.set_data = function(query, res) {
    var msr_names = this.measures().map(function(m) {
        return m.name;
    });
    var dim_names = this.dimensions().map(function(d) {
        return d.name();
    });
    var columns = res.columns;
    for (var x in res.data) {
        var line = res.data[x];
        for (var y in columns) {
            var c = columns[y];
            var val = line[y];
            if (c.type == 'dimension') {
                line[y] = val.join('/');
            } else if (c.type == 'measure') {
                if (val === undefined) {
                    line[y] = 0;
                } else if (val.toFixed) {
                    if (c.name == 'amount') {
                        line[y] = to_money(val);
                    }
                }
            }
        }
    }

    // Store in cache
    DATA_CACHE[query] = res;
    this.data(res.data);
    this.columns(res.columns);
};

DataSet.prototype.get_xlsx = function() {
    this.fetch_data('xlsx');
};

var init = function() {
    var ds = new DataSet();
    ko.applyBindings(ds, $('body')[0]);

};

$(init);
